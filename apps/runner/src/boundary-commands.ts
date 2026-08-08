import {
  ProposalStore
} from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  inspectDatabase
} from "@synapsor-runner/schema-inspector";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import {
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  activateExplorationBoundary,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundary,
  reviewExplorationBoundaryCandidate,
  type ExplorationBoundaryDraft,
  type GenerationLock
} from "./auto-boundary.js";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists, readJsonFileWithLocation } from "./cli-files.js";
import { shellQuote } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { redactCliErrorMessage } from "./cli-logging.js";
import { assertKnownOptions, envValue, listArg, optionalArg, positional } from "./cli-options.js";
import { readRuntimeConfig } from "./cli-project.js";
import {
  readGuidedOnboardingState,
  updateGuidedOnboardingState,
} from "./guided-project.js";
import {
  boundaryReviewDecisions,
  createBoundaryReviewProgress,
  readBoundaryReviewProgress,
  saveBoundaryReviewProgress
} from "./boundary-review-domain.js";
import { displayPath } from "./onboarding.js";
import { formatDerivedScopePath } from "./derived-scope-display.js";
import { resolveOperatorIdentity, verifyJwtOperatorProof, verifySignedOperatorProof, type OperatorIdentityConfig } from "./operator-identity.js";
import { resolveSynapsorProject } from "./project-resolution.js";
import { disableScopedExplore } from "./protect-query.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import {
  createSavedBoundary,
  deleteSavedBoundary,
  renameSavedBoundary,
  switchSavedBoundary,
  synchronizeBoundaryLibrary,
} from "./boundary-library.js";
import { compileSafeActionDraft, safeActionStatus, SafeActionValidationError, scaffoldSafeAction } from "./safe-action.js";
import {
  boundaryReviewRequestsFromDecisionFile,
  parseBoundaryReviewDecisionFile,
} from "./boundary-review-decision-file.js";
import {
  createBoundaryReviewInteractiveSession,
  formatBoundaryOverviewMap,
  formatBoundaryResourceMap,
  terminalTheme,
  type BoundaryFieldTier,
  type BoundaryReviewOverview,
  type BoundaryReviewInteractiveSession,
} from "./boundary-cli-picker.js";
import {
  commitBoundaryReviewMutationBatch,
  commitBoundaryResourceReviewMutation,
  inspectBoundaryResourceReview,
  listBoundaryResourceReviews,
  prepareBoundaryReviewMutationBatch,
  prepareBoundaryResourceReviewMutation,
  type BoundaryResourceReviewView,
  type BoundaryResourceReviewRequest,
  type BoundaryReviewMutationBatchPreview,
  type BoundaryReviewMutationBindings,
  type BoundaryReviewMutationPreview,
} from "./boundary-review-mutation.js";


type BoundaryReviewBundle = {
  schema_version: "synapsor.boundary-review-bundle.v1";
  candidate_digest: `sha256:${string}`;
  bundle_digest: `sha256:${string}`;
  activation: "disabled_unreviewed";
  mutation_bindings: BoundaryReviewMutationBindings;
  authority: {
    source: string;
    deployment_profile: "development" | "staging" | "production";
    compiler_version: string;
    spec_version: string;
    generation_lock_fingerprint: `sha256:${string}`;
    schema_fingerprint: `sha256:${string}`;
    role_posture_fingerprint: `sha256:${string}`;
    environment: string;
    budgets: ExplorationBoundaryDraft["budgets"];
  };
  decisions: Array<ReturnType<typeof boundaryReviewDecisions>[number] & { confirmed: boolean }>;
  outstanding_decision_ids: string[];
  candidate: ExplorationBoundaryDraft;
};

export type BoundaryActivationHandoff = (input: {
  projectRoot: string;
  boundaryName: string;
  boundaryDigest: `sha256:${string}`;
}) => Promise<number>;

export type BoundaryReviewCommandOptions = {
  activationReviewNotice?: (input: {
    projectRoot: string;
    boundaryName: string;
    boundaryDigest: `sha256:${string}`;
  }) => string;
  startAtBoundaryList?: boolean;
};

export async function boundaryRenameCommand(args: string[]): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--project-root", "--to", "--actor", "--reason", "--json"]),
    "boundary rename",
  );
  const currentName = positional(args, 0)?.trim();
  const newName = optionalArg(args, "--to")?.trim().toLowerCase();
  const actor = optionalArg(args, "--actor")?.trim();
  const reason = optionalArg(args, "--reason")?.trim();
  if (!currentName || !newName) {
    throw new Error("boundary rename requires <current-name> --to <new-name>.");
  }
  if (!actor || !reason) {
    throw new Error("Renaming a disabled boundary requires --actor <human> and --reason <review-reason>.");
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  let context = await loadBoundaryReviewContext(projectRoot);
  await synchronizeBoundaryLibrary({
    projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
  });
  if (context.candidate.pack.name !== currentName) {
    await switchSavedBoundary({
      projectRoot,
      draft: context.draft,
      currentCandidate: context.candidate,
      ...(context.progress ? { currentProgress: context.progress } : {}),
      name: currentName,
    });
    context = await loadBoundaryReviewContext(projectRoot);
  }
  const progress = await renameSavedBoundary({
    projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
    name: currentName,
    newName,
    actor,
    reason,
  });
  const payload = {
    ok: true,
    previous_name: currentName,
    name: progress.candidate.pack.name,
    state: "disabled",
    table_count: progress.candidate.pack.resources.length,
    authority_activated: false,
    source_database_changed: false,
  };
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify(payload, null, 2)}\n`
    : [
      `Renamed disabled boundary "${currentName}" to "${payload.name}".`,
      `Tables retained: ${payload.table_count}`,
      "Authority activated: no",
      "Source database changed: no",
      `Next: ${cliCommandName()} boundary review`,
      "",
    ].join("\n"));
  return 0;
}

export async function boundaryDeleteCommand(
  args: string[],
  session?: Pick<BoundaryReviewInteractiveSession, "confirm">,
): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--project-root", "--yes", "--json"]),
    "boundary delete",
  );
  const name = positional(args, 0)?.trim();
  if (!name) throw new Error("boundary delete requires <disabled-boundary-name>.");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  if (!args.includes("--yes")) {
    const interactive = session ?? (process.stdin.isTTY && process.stdout.isTTY
      ? createBoundaryReviewInteractiveSession()
      : undefined);
    if (!interactive) {
      throw new Error("boundary delete requires --yes outside an interactive terminal.");
    }
    if (!await interactive.confirm(`Delete saved disabled boundary "${name}"?`, { defaultValue: false })) {
      process.stdout.write("Boundary deletion cancelled. Nothing changed.\n");
      return 0;
    }
  }
  const context = await loadBoundaryReviewContext(projectRoot);
  await synchronizeBoundaryLibrary({
    projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
  });
  const deleted = await deleteSavedBoundary({
    projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
    name,
  });
  const payload = {
    ok: true,
    deleted: name,
    selected_boundary: deleted.selected_name,
    authority_activated: false,
    source_database_changed: false,
  };
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify(payload, null, 2)}\n`
    : [
      `Deleted saved disabled boundary "${name}".`,
      `Selected boundary: ${deleted.selected_name}`,
      "Active reviewed boundaries were unchanged.",
      "Source database changed: no",
      "",
    ].join("\n"));
  return 0;
}


export async function boundaryReviewCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
  interactiveSession?: BoundaryReviewInteractiveSession,
  activationHandoff?: BoundaryActivationHandoff,
  options: BoundaryReviewCommandOptions = {},
): Promise<number> {
  if (args.includes("--apply-decisions")) {
    return boundaryDecisionFileCommand(args, schemaInspector);
  }
  if (args[0] === "resource") {
    return boundaryResourceReviewCommand(
      args.slice(1),
      schemaInspector,
      interactiveSession,
      activationHandoff,
      options,
    );
  }
  assertKnownOptions(
    args,
    new Set(["--project-root", "--output", "--json", "--confirm", "--actor", "--map", "--all", "--access"]),
    "boundary review",
  );
  if (args.includes("--all") && !args.includes("--map")) {
    throw new Error("Boundary review --all is available only with --map.");
  }
  if (args.includes("--confirm") && args.includes("--json")) {
    throw new Error("Interactive boundary review cannot use --json; confirm decisions in a terminal, then export JSON.");
  }
  if (args.includes("--access")
    && (args.includes("--json")
      || args.includes("--confirm")
      || args.includes("--map")
      || args.includes("--all")
      || optionalArg(args, "--output") !== undefined)) {
    throw new Error(
      "The focused boundary access editor cannot be combined with JSON, map, confirmation, or output options.",
    );
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  if (args.includes("--map")) {
    if (args.includes("--json") || args.includes("--confirm") || optionalArg(args, "--output")) {
      throw new Error(
        "Boundary overview --map is human-readable inspection and cannot be combined with JSON, confirmation, or output-file options.",
      );
    }
    process.stdout.write(formatBoundaryOverviewMap(
      await listBoundaryResourceReviews(projectRoot),
      {
        color: process.stdout.isTTY,
        exhaustive: args.includes("--all"),
        commandName: cliCommandName(),
      },
    ));
    return 0;
  }
  const explicitSummaryOutput = args.includes("--json")
    || optionalArg(args, "--output") !== undefined
    || args.includes("--confirm");
  if (!explicitSummaryOutput) {
    const session = interactiveSession
      ?? (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY
        ? createBoundaryReviewInteractiveSession()
        : undefined);
    if (!session) {
      process.stdout.write(formatBoundaryOverviewMap(
        await listBoundaryResourceReviews(projectRoot),
        {
          color: false,
          exhaustive: false,
          commandName: cliCommandName(),
        },
      ));
      return 0;
    }
    return interactiveBoundaryReviewLoop({
      projectRoot,
      schemaInspector,
      session,
      activationHandoff,
      activationReviewNotice: options.activationReviewNotice,
      initialView: args.includes("--access") ? "access" : "boundaries",
      startAtBoundaryList: options.startAtBoundaryList,
    });
  }
  let context = await loadBoundaryReviewContext(projectRoot);
  let reviewActor: string | undefined;
  let reviewSession: BoundaryReviewInteractiveSession | undefined;
  if (args.includes("--confirm")) {
    if (!interactiveSession && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error(
        "Interactive boundary review requires a real terminal. For automation, export a review bundle and use boundary activate --headless with a verified signed_key or jwt_oidc identity.",
      );
    }
    reviewSession = interactiveSession ?? createBoundaryReviewInteractiveSession();
    const reviewed = await confirmBoundaryReviewInteractively({
      projectRoot,
      context,
      session: reviewSession,
      actor: optionalArg(args, "--actor")?.trim(),
    });
    context = reviewed.context;
    reviewActor = reviewed.actor;
  }

  const output = optionalArg(args, "--output");
  if (output) {
    const outputPath = path.resolve(output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(context.bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`Wrote deterministic boundary review bundle: ${displayPath(outputPath)}\n`);
  }
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(context.bundle, null, 2)}\n`);
  } else if ((!output || args.includes("--confirm"))
    && !(args.includes("--confirm")
      && !output
      && context.bundle.outstanding_decision_ids.length === 0)) {
    process.stdout.write(formatBoundaryReviewSummary(context.bundle));
  }
  if (args.includes("--confirm")
    && !output
    && context.bundle.outstanding_decision_ids.length === 0) {
    return boundaryActivateCommand(
      [
        "--project-root", projectRoot,
        ...(reviewActor ? ["--actor", reviewActor] : []),
      ],
      schemaInspector,
      reviewSession,
      activationHandoff,
    );
  }
  return 0;
}

export async function boundaryDisableCommand(
  args: string[],
  interactiveSession?: BoundaryReviewInteractiveSession,
): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--project-root", "--name", "--actor", "--confirm", "--yes", "--json"]),
    "boundary disable",
  );
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const activePath = path.join(projectRoot, ".synapsor/exploration-boundary.active.json");
  if (!await fileExists(activePath)) {
    const payload = {
      ok: true,
      disabled: false,
      activation: "disabled",
      protected_capabilities_changed: false,
      review_state_changed: false,
      source_database_changed: false,
      message: "Scoped Explore is already disabled.",
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write([
      payload.message,
      "The disabled next boundary, review decisions, protected capabilities, evidence, and ledger were preserved.",
      "",
    ].join("\n"));
    return 0;
  }

  const requestedName = optionalArg(args, "--name")?.trim();
  const active = await loadActivatedExplorationBoundary(
    projectRoot,
    requestedName ? { name: requestedName } : undefined,
  );
  const expectedConfirmation = `DISABLE ${active.activation.digest}`;
  const actor = optionalArg(args, "--actor")?.trim()
    || envValue(process.env, "USER")
    || "local-operator";
  const suppliedConfirmation = optionalArg(args, "--confirm")?.trim();
  let confirmed = args.includes("--yes") || suppliedConfirmation === expectedConfirmation;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!confirmed) {
      throw new Error(
        `Noninteractive boundary disable requires --confirm ${shellQuote(expectedConfirmation)}.`,
      );
    }
  } else if (!confirmed) {
    if (interactiveSession) {
      confirmed = await interactiveSession.confirm(
        `Disable Scoped Explore boundary "${active.pack.name}"? ` +
        "The disabled next boundary and protected capabilities stay intact.",
      ) === true;
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await rl.question(
          `Disable Scoped Explore boundary "${active.pack.name}"? ` +
          "The disabled next boundary and protected capabilities stay intact. [y/N] ",
        )).trim().toLowerCase();
        confirmed = answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    }
  }
  if (!confirmed) {
    process.stdout.write("Scoped Explore remains active. Nothing changed.\n");
    return 0;
  }

  const result = await disableScopedExplore(projectRoot, active.pack.name);
  await updateGuidedOnboardingState({
    projectRoot,
    status: "review_boundary",
    authorityActive: result.remaining_boundaries.length > 0,
    recommendedNextAction: result.remaining_boundaries.length
      ? "Continue asking through the remaining active boundaries, or review another saved boundary."
      : "Review or reactivate a saved boundary.",
  }).catch(() => undefined);
  const payload = {
    ok: true,
    ...result,
    activation: "disabled",
    boundary_name: active.pack.name,
    disabled_digest: active.activation.digest,
    actor,
    protected_capabilities_changed: false,
    review_state_changed: false,
    source_database_changed: false,
    next_action: `${cliCommandName()} boundary review --project-root ${shellQuote(displayPath(projectRoot))}`,
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write([
    `Scoped Explore boundary "${payload.boundary_name}" is disabled.`,
    `Disabled authority: ${payload.disabled_digest}`,
    "Preserved: disabled next boundary, review decisions, protected capabilities, evidence, and ledger.",
    "Source database changed: no.",
    `Next: ${payload.next_action}`,
    "",
  ].join("\n"));
  return 0;
}

async function boundaryDecisionFileCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase,
): Promise<number> {
  assertKnownOptions(
    args,
    new Set([
      "--project-root",
      "--apply-decisions",
      "--apply",
      "--confirm",
      "--json",
      "--config",
      "--identity",
      "--identity-key",
      "--required-role",
      "--expires-at",
      "--nonce",
    ]),
    "boundary review --apply-decisions",
  );
  const decisionPath = optionalArg(args, "--apply-decisions");
  if (!decisionPath) {
    throw new Error("boundary review --apply-decisions requires a versioned JSON decision file.");
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const file = parseBoundaryReviewDecisionFile(
    await readJsonFileWithLocation<unknown>(decisionPath, "boundary-review decision file"),
  );
  const context = await loadBoundaryReviewContext(projectRoot);
  if (file.review_bundle_digest !== context.bundle.bundle_digest) {
    throw new Error(
      "Boundary-review decision file is stale or belongs to another review bundle. " +
      "No decision was applied; export the current boundary review and prepare a new decision file.",
    );
  }
  const requests = boundaryReviewRequestsFromDecisionFile(file);
  const preview = await prepareBoundaryReviewMutationBatch(
    projectRoot,
    requests,
    schemaInspector,
    file.bindings,
  );
  const expectedConfirmation = `APPLY REVIEW ${preview.decision_digest}`;
  const shouldApply = args.includes("--apply") || optionalArg(args, "--confirm") !== undefined;
  if (!shouldApply) {
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(boundaryBatchMutationPublicPreview(preview), null, 2)}\n`
      : formatBoundaryBatchMutationPreview(preview, expectedConfirmation));
    return 0;
  }

  let confirmation = optionalArg(args, "--confirm")?.trim();
  let verifiedDecision: Awaited<ReturnType<typeof verifyBoundaryReviewMutationOperator>> | undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (confirmation !== expectedConfirmation) {
      throw new Error(`Noninteractive boundary-review mutation requires --confirm ${shellQuote(expectedConfirmation)}.`);
    }
    verifiedDecision = await verifyBoundaryReviewMutationOperator({
      args,
      projectRoot,
      preview,
      expectedActor: file.actor,
      reason: file.reason,
    });
  } else if (!confirmation) {
    process.stdout.write(formatBoundaryBatchMutationPreview(preview, expectedConfirmation));
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      confirmation = (await rl.question(
        `Type ${expectedConfirmation} to save all disabled review decisions atomically: `,
      )).trim();
    } finally {
      rl.close();
    }
  }
  if (confirmation !== expectedConfirmation) {
    throw new Error(`Boundary-review mutation requires the exact confirmation ${expectedConfirmation}.`);
  }

  let committed: Awaited<ReturnType<typeof commitBoundaryReviewMutationBatch>>;
  try {
    committed = await commitBoundaryReviewMutationBatch(projectRoot, preview);
    if (verifiedDecision) {
      verifiedDecision.store.setRunnerState(verifiedDecision.key, {
        status: "applied_disabled_review",
        decision_id: verifiedDecision.decisionId,
        review_decision_digest: preview.decision_digest,
        candidate_digest: committed.candidate_digest,
        resource_count: preview.requests.length,
        subject: verifiedDecision.subject,
        provider: verifiedDecision.provider,
        applied_at: new Date().toISOString(),
        source_database_changed: false,
      });
    }
  } catch (error) {
    if (verifiedDecision) {
      verifiedDecision.store.setRunnerState(verifiedDecision.key, {
        status: "consumed_review_failed",
        decision_id: verifiedDecision.decisionId,
        review_decision_digest: preview.decision_digest,
        subject: verifiedDecision.subject,
        provider: verifiedDecision.provider,
        failed_at: new Date().toISOString(),
        safe_error: redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
        source_database_changed: false,
      });
    }
    throw error;
  } finally {
    verifiedDecision?.store.close();
  }
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify({ ok: true, decision_digest: preview.decision_digest, ...committed }, null, 2)}\n`
    : [
      `Saved ${preview.requests.length} disabled boundary decisions in review revision ${committed.review_revision}.`,
      `Candidate digest: ${committed.candidate_digest}`,
      "Authority activated: no",
      "Source database changed: no",
      `Next: ${cliCommandName()} boundary review --project-root ${shellQuote(projectRoot)}`,
      "",
    ].join("\n"));
  return 0;
}


async function boundaryResourceReviewCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase,
  interactiveSession?: BoundaryReviewInteractiveSession,
  activationHandoff?: BoundaryActivationHandoff,
  options: BoundaryReviewCommandOptions = {},
): Promise<number> {
  const allowed = new Set([
    "--project-root",
    "--json",
    "--map",
    "--include",
    "--exclude",
    "--row-identity",
    "--tenant-key",
    "--tenant-scope-path",
    "--shared-reference",
    "--acknowledge-table-has-no-per-tenant-rows",
    "--principal-key",
    "--principal-scope-path",
    "--no-principal",
    "--keep-out",
    "--withhold-from-model",
    "--allow-reviewed-field",
    "--visible-fields",
    "--filter-fields",
    "--sort-fields",
    "--group-fields",
    "--measure-fields",
    "--count-distinct-fields",
    "--time-fields",
    "--minimum-cohort",
    "--max-ranked-groups",
    "--relationships",
    "--nullable-relationship",
    "--unmatched-rows",
    "--actor",
    "--reason",
    "--apply",
    "--confirm",
    "--config",
    "--identity",
    "--identity-key",
    "--required-role",
    "--expires-at",
    "--nonce",
  ]);
  assertKnownOptions(args, allowed, "boundary review resource");
  const resourceId = positional(args, 0);
  if (!resourceId) {
    throw new Error("boundary review resource requires <schema.table>, for example public.orders.");
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const mutationRequested = args.some((arg) => [
    "--include",
    "--exclude",
    "--row-identity",
    "--tenant-key",
    "--tenant-scope-path",
    "--shared-reference",
    "--acknowledge-table-has-no-per-tenant-rows",
    "--principal-key",
    "--principal-scope-path",
    "--no-principal",
    "--keep-out",
    "--withhold-from-model",
    "--allow-reviewed-field",
    "--visible-fields",
    "--filter-fields",
    "--sort-fields",
    "--group-fields",
    "--measure-fields",
    "--count-distinct-fields",
    "--time-fields",
    "--minimum-cohort",
    "--max-ranked-groups",
    "--relationships",
    "--nullable-relationship",
  ].includes(arg));
  if (args.includes("--map") && mutationRequested) {
    throw new Error("boundary review resource --map is inspection-only and cannot be combined with decision flags.");
  }
  if (!mutationRequested) {
    const view = await inspectBoundaryResourceReview(projectRoot, resourceId);
    if (args.includes("--map")) {
      if (args.includes("--json")) {
        throw new Error("boundary review resource accepts either --map or --json, not both.");
      }
      process.stdout.write(formatBoundaryResourceMap(view, { color: process.stdout.isTTY }));
      return 0;
    }
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      return 0;
    }
    const session = interactiveSession
      ?? (process.stdin.isTTY && process.stderr.isTTY
        ? createBoundaryReviewInteractiveSession()
        : undefined);
    if (!session) {
      process.stderr.write([
        `No boundary decision was supplied for ${resourceId}.`,
        `Use decision flags such as --withhold-from-model <column> with --actor and --reason,`,
        `or run ${cliCommandName()} boundary review in a terminal for the interactive picker.`,
        "",
      ].join("\n"));
      usage(["boundary"]);
      return 2;
    }
    const result = await interactiveBoundaryResourceReview({
      projectRoot,
      resourceId,
      view,
      schemaInspector,
      session,
    });
    if (result === "back") {
      return interactiveBoundaryReviewLoop({
        projectRoot,
        schemaInspector,
        session,
        activationHandoff,
        activationReviewNotice: options.activationReviewNotice,
      });
    }
    if (result === "review") {
      return confirmAndActivateFocusedBoundary({
        projectRoot,
        schemaInspector,
        session,
        activationHandoff,
        activationReviewNotice: options.activationReviewNotice,
      });
    }
    return result;
  }

  const actor = optionalArg(args, "--actor")?.trim();
  const reason = optionalArg(args, "--reason")?.trim();
  if (!actor || !reason) {
    throw new Error("Changing disabled boundary review state requires --actor <human> and --reason <concrete-review-reason>.");
  }
  if (args.includes("--principal-key") && args.includes("--no-principal")) {
    throw new Error("Use either --principal-key <column> or --no-principal, not both.");
  }
  const sharedReference = args.includes("--shared-reference");
  const sharedReferenceAcknowledged = args.includes(
    "--acknowledge-table-has-no-per-tenant-rows",
  );
  if (sharedReference !== sharedReferenceAcknowledged) {
    throw new Error(
      "--shared-reference requires --acknowledge-table-has-no-per-tenant-rows, and the acknowledgement is valid only with --shared-reference.",
    );
  }
  const tenantModeFlags = [
    args.includes("--tenant-key"),
    args.includes("--tenant-scope-path"),
    sharedReference,
  ].filter(Boolean).length;
  if (tenantModeFlags > 1) {
    throw new Error(
      "Use one tenant mode: --tenant-key, --tenant-scope-path, or --shared-reference with its acknowledgement.",
    );
  }
  if (args.includes("--principal-scope-path")
    && (args.includes("--principal-key") || args.includes("--no-principal"))) {
    throw new Error("Use one of --principal-key <column>, --principal-scope-path <path>, or --no-principal.");
  }
  const nullableRelationship = optionalArg(args, "--nullable-relationship");
  const unmatchedRows = optionalArg(args, "--unmatched-rows");
  const minimumCohortText = optionalArg(args, "--minimum-cohort");
  const minimumCohort = minimumCohortText === undefined
    ? undefined
    : Number(minimumCohortText);
  if (minimumCohortText !== undefined
    && (typeof minimumCohort !== "number"
      || !Number.isSafeInteger(minimumCohort)
      || minimumCohort < 1
      || minimumCohort > 5)) {
    throw new Error(
      "--minimum-cohort must be an integer from 1 through 5. A value of 1 disables small-group suppression and can identify individuals; 5 restores the default.",
    );
  }
  const maxRankedGroupsText = optionalArg(args, "--max-ranked-groups");
  const maxRankedGroups = maxRankedGroupsText === undefined
    ? undefined
    : Number(maxRankedGroupsText);
  if (maxRankedGroupsText !== undefined
    && (!Number.isSafeInteger(maxRankedGroups)
      || Number(maxRankedGroups) < 1
      || Number(maxRankedGroups) > 10_000)) {
    throw new Error("--max-ranked-groups must be an integer from 1 through 10000.");
  }
  if ((nullableRelationship && unmatchedRows !== "exclude" && unmatchedRows !== "keep_null")
    || (!nullableRelationship && unmatchedRows)) {
    throw new Error("--nullable-relationship <id> requires --unmatched-rows exclude|keep_null.");
  }
  const request: BoundaryResourceReviewRequest = {
    resource_id: resourceId,
    ...(args.includes("--include") ? { include: true } : {}),
    ...(args.includes("--exclude") ? { exclude: true } : {}),
    ...(optionalArg(args, "--row-identity") ? { row_identity: optionalArg(args, "--row-identity") } : {}),
    ...(optionalArg(args, "--tenant-key") ? { tenant_key: optionalArg(args, "--tenant-key") } : {}),
    ...(optionalArg(args, "--tenant-scope-path")
      ? { tenant_scope_path: optionalArg(args, "--tenant-scope-path") }
      : {}),
    ...(sharedReference
      ? { shared_reference_scope: SHARED_REFERENCE_ACKNOWLEDGEMENT }
      : {}),
    ...(args.includes("--no-principal")
      ? { principal_key: null, principal_scope_path: null }
      : optionalArg(args, "--principal-key")
        ? { principal_key: optionalArg(args, "--principal-key") }
        : optionalArg(args, "--principal-scope-path")
          ? { principal_scope_path: optionalArg(args, "--principal-scope-path") }
          : {}),
    ...(listArg(args, "--keep-out") ? { keep_out_fields: listArg(args, "--keep-out") } : {}),
    ...(listArg(args, "--withhold-from-model")
      ? { withhold_from_model_fields: listArg(args, "--withhold-from-model") }
      : {}),
    ...(listArg(args, "--allow-reviewed-field")
      ? { allow_reviewed_fields: listArg(args, "--allow-reviewed-field") }
      : {}),
    ...(listArg(args, "--visible-fields") ? { selectable_fields: listArg(args, "--visible-fields") } : {}),
    ...(listArg(args, "--filter-fields") ? { filterable_fields: listArg(args, "--filter-fields") } : {}),
    ...(listArg(args, "--sort-fields") ? { sortable_fields: listArg(args, "--sort-fields") } : {}),
    ...(listArg(args, "--group-fields") ? { groupable_fields: listArg(args, "--group-fields") } : {}),
    ...(listArg(args, "--measure-fields") ? { aggregate_measures: listArg(args, "--measure-fields") } : {}),
    ...(listArg(args, "--count-distinct-fields")
      ? { count_distinct_fields: listArg(args, "--count-distinct-fields") }
      : {}),
    ...(listArg(args, "--time-fields") ? { time_bucket_fields: listArg(args, "--time-fields") } : {}),
    ...(minimumCohort === undefined ? {} : { minimum_cohort_size: minimumCohort }),
    ...(maxRankedGroups === undefined ? {} : { max_ranked_groups: maxRankedGroups }),
    ...(listArg(args, "--relationships") ? { relationship_ids: listArg(args, "--relationships") } : {}),
    ...(nullableRelationship ? {
      nullable_relationship: {
        relationship_id: nullableRelationship,
        unmatched_rows: unmatchedRows as "exclude" | "keep_null",
      },
    } : {}),
    actor,
    reason,
  };
  const preview = await prepareBoundaryResourceReviewMutation(projectRoot, request, schemaInspector);
  const view = await inspectBoundaryResourceReview(projectRoot, resourceId);
  const expectedConfirmation = `APPLY REVIEW ${preview.decision_digest}`;
  const applyCommand = boundaryResourceApplyCommand(args);
  const shouldApply = args.includes("--apply") || optionalArg(args, "--confirm") !== undefined;
  if (!shouldApply) {
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(boundaryMutationPublicPreview(preview), null, 2)}\n`
      : formatBoundaryMutationPreview(preview, view, applyCommand));
    return 0;
  }
  let confirmation = optionalArg(args, "--confirm")?.trim();
  let verifiedDecision: Awaited<ReturnType<typeof verifyBoundaryReviewMutationOperator>> | undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (confirmation !== expectedConfirmation) {
      throw new Error(`Noninteractive boundary-review mutation requires --confirm ${shellQuote(expectedConfirmation)}.`);
    }
    verifiedDecision = await verifyBoundaryReviewMutationOperator({
      args,
      projectRoot,
      preview,
      expectedActor: actor,
      reason,
    });
  } else if (!confirmation) {
    process.stdout.write(formatBoundaryMutationPreview(preview, view, applyCommand));
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      confirmation = (await rl.question(`Type ${expectedConfirmation} to save this disabled review state: `)).trim();
    } finally {
      rl.close();
    }
  }
  if (confirmation !== expectedConfirmation) {
    throw new Error(`Boundary-review mutation requires the exact confirmation ${expectedConfirmation}.`);
  }
  let committed: Awaited<ReturnType<typeof commitBoundaryResourceReviewMutation>>;
  try {
    committed = await commitBoundaryResourceReviewMutation(projectRoot, preview);
    if (verifiedDecision) {
      verifiedDecision.store.setRunnerState(verifiedDecision.key, {
        status: "applied_disabled_review",
        decision_id: verifiedDecision.decisionId,
        review_decision_digest: preview.decision_digest,
        candidate_digest: committed.candidate_digest,
        subject: verifiedDecision.subject,
        provider: verifiedDecision.provider,
        applied_at: new Date().toISOString(),
        source_database_changed: false,
      });
    }
  } catch (error) {
    if (verifiedDecision) {
      verifiedDecision.store.setRunnerState(verifiedDecision.key, {
        status: "consumed_review_failed",
        decision_id: verifiedDecision.decisionId,
        review_decision_digest: preview.decision_digest,
        subject: verifiedDecision.subject,
        provider: verifiedDecision.provider,
        failed_at: new Date().toISOString(),
        safe_error: redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
        source_database_changed: false,
      });
    }
    throw error;
  } finally {
    verifiedDecision?.store.close();
  }
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify({ ok: true, decision_digest: preview.decision_digest, ...committed }, null, 2)}\n`
    : formatBoundaryMutationCommit(
      projectRoot,
      committed.review_revision,
      committed.candidate_digest,
      actor,
    ));
  return 0;
}

async function interactiveBoundaryReviewLoop(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  activationHandoff?: BoundaryActivationHandoff;
  activationReviewNotice?: BoundaryReviewCommandOptions["activationReviewNotice"];
  initialView?: "boundaries" | "access";
  startAtBoundaryList?: boolean;
}): Promise<number> {
  let startAtBoundaryList = input.startAtBoundaryList;
  let selectedResourceId: string | undefined;
  while (true) {
    let context = await loadBoundaryReviewContext(input.projectRoot);
    const boundaryLibrary = await synchronizeBoundaryLibrary({
      projectRoot: input.projectRoot,
      draft: context.draft,
      currentCandidate: context.candidate,
      ...(context.progress ? { currentProgress: context.progress } : {}),
    });
    context = await loadBoundaryReviewContext(input.projectRoot);
    const selected = await input.session.chooseResource(
      await listBoundaryResourceReviews(input.projectRoot),
      {
        ...boundaryReviewOverview(context.bundle),
        boundaries: boundaryLibrary.entries,
      },
      {
        initialView: input.initialView ?? "boundaries",
        startAtBoundaryList,
        ...(selectedResourceId ? { initialResourceId: selectedResourceId } : {}),
      },
    );
    if (!selected) {
      process.stdout.write(input.initialView === "access"
        ? [
            "Access editor closed. Reviewed authority is unchanged.",
            "Returning to Ask.",
            "",
          ].join("\n")
        : [
            "Boundary review paused. No new decision or authority was recorded.",
            `Resume: ${cliCommandName()} start --from-env ${context.lock.source_env} --cli`,
            "",
          ].join("\n"));
      return 0;
    }
    if (selected.action === "rename") {
      const result = await interactiveBoundaryRename({
        projectRoot: input.projectRoot,
        session: input.session,
      });
      if (result !== 0) return result;
      continue;
    }
    if (selected.action === "limits") {
      const result = await interactiveRankedGroupReview({
        projectRoot: input.projectRoot,
        schemaInspector: input.schemaInspector,
        session: input.session,
      });
      if (result !== 0) return result;
      continue;
    }
    if (selected.action === "privacy_all") {
      const result = await interactiveBoundaryMinimumCohortReview({
        projectRoot: input.projectRoot,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: input.initialView === "access",
      });
      if (result === "review") {
        if (input.initialView === "access") {
          const activationResult = await confirmActivateAndKeepAccessOpen(input);
          if (activationResult !== 0) return activationResult;
        }
        continue;
      }
      if (result !== "back" && result !== 0) return result;
      continue;
    }
    if (selected.action === "create") {
      const requestedName = await input.session.promptText(
        "New boundary name: ",
      );
      if (!requestedName) {
        process.stdout.write("New boundary cancelled. Nothing was saved or activated.\n");
        continue;
      }
      const name = requestedName.trim().toLowerCase();
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
        process.stdout.write([
          "Boundary was not created.",
          "Use 1-64 letters, numbers, dots, dashes, or underscores; start with a letter.",
          "You are still in boundary review. Active authority and Ask access are unchanged.",
          "",
        ].join("\n"));
        continue;
      }
      if (name !== requestedName.trim()) {
        process.stdout.write(`Using lower-case boundary name "${name}".\n`);
      }
      const startingResources = (await listBoundaryResourceReviews(input.projectRoot))
        .map((resource) => ({
          ...resource,
          candidate_boundary_name: name,
          active: false,
          included: false,
          pending_decisions: [],
          risk_count: resource.blockers.length,
        }))
        .sort((left, right) =>
          Number(left.first_table_startable === false) - Number(right.first_table_startable === false)
          || Number(left.status !== "draft_read") - Number(right.status !== "draft_read")
          || right.risk_count - left.risk_count
          || left.resource_id.localeCompare(right.resource_id));
      if (!startingResources.some((resource) =>
        resource.first_table_startable !== false
        && (resource.status === "draft_read" || resource.inline_resolution_available === true))) {
        process.stdout.write([
          "Boundary was not created because no inspected table can safely start it alone.",
          "Start from a directly scoped ancestor. Derived tables can be added after their required ancestor is inside the boundary.",
          "",
        ].join("\n"));
        continue;
      }
      const startingSelection = await input.session.chooseResource(
        startingResources,
        undefined,
        { initialView: "access", startingBoundaryName: name },
      );
      if (!startingSelection || !("resource_id" in startingSelection)) {
        process.stdout.write("New boundary cancelled. Nothing was saved or activated.\n");
        continue;
      }
      const startingSummary = startingResources.find((resource) =>
        resource.resource_id === startingSelection.resource_id);
      if (startingSummary?.first_table_startable === false) {
        process.stdout.write([
          `${startingSelection.resource_id} cannot be the first table in this boundary.`,
          `${startingSummary.first_table_guidance ?? "Add its directly scoped ancestor first."}.`,
          `Its required scope is derived through ${startingSummary.first_table_scope_label ?? "a mandatory reviewed relationship path"}.`,
          "No table review was started, and nothing was saved or activated.",
          "",
        ].join("\n"));
        continue;
      }
      let startingView = await inspectBoundaryResourceReview(
        input.projectRoot,
        startingSelection.resource_id,
      );
      if (!startingView.generated_candidate) {
        const resolved = await resolveBlockedBoundaryResource({
          projectRoot: input.projectRoot,
          view: startingView,
          schemaInspector: input.schemaInspector,
          session: input.session,
          include: false,
        });
        if (resolved === "back" || !resolved) {
          process.stdout.write("New boundary cancelled. Nothing was saved or activated.\n");
          continue;
        }
        startingView = resolved;
        context = await loadBoundaryReviewContext(input.projectRoot);
      }
      let progress;
      try {
        progress = await createSavedBoundary({
          projectRoot: input.projectRoot,
          draft: context.draft,
          currentCandidate: context.candidate,
          ...(context.progress ? { currentProgress: context.progress } : {}),
          name,
          resourceId: startingSelection.resource_id,
          actor: localInteractiveActor(),
        });
      } catch (error) {
        process.stdout.write([
          `Boundary was not created: ${redactCliErrorMessage(
            error instanceof Error ? error.message : String(error),
          )}`,
          "You are still in boundary review. Active authority and Ask access are unchanged.",
          "",
        ].join("\n"));
        continue;
      }
      process.stdout.write([
        `Created disabled boundary "${progress.candidate.pack.name}" with ${startingSelection.resource_id}.`,
        "Authority activated: no",
        "Review this table's column access now; activation remains a separate exact review.",
        "",
      ].join("\n"));
      startAtBoundaryList = false;
      startingView = await inspectBoundaryResourceReview(
        input.projectRoot,
        startingSelection.resource_id,
      );
      const editResult = await interactiveBoundaryResourceReview({
        projectRoot: input.projectRoot,
        resourceId: startingSelection.resource_id,
        view: startingView,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: true,
      });
      if (editResult === "review") {
        const activationResult = await confirmActivateAndKeepAccessOpen(input);
        if (activationResult !== 0) return activationResult;
        continue;
      }
      if (editResult !== "back" && editResult !== 0) return editResult;
      continue;
    }
    if (selected.action === "switch") {
      await switchSavedBoundary({
        projectRoot: input.projectRoot,
        draft: context.draft,
        currentCandidate: context.candidate,
        ...(context.progress ? { currentProgress: context.progress } : {}),
        name: selected.boundary_name,
      });
      process.stdout.write(
        `Opened saved boundary "${selected.boundary_name}" for editing. Active Explore authority did not change.\n`,
      );
      selectedResourceId = undefined;
      continue;
    }
    if (selected.action === "delete") {
      const accepted = await input.session.confirm(
        `Delete saved disabled boundary "${selected.boundary_name}"?`,
        { defaultValue: false },
      );
      if (!accepted) {
        process.stdout.write("Boundary deletion cancelled. Nothing changed.\n");
        continue;
      }
      const result = await deleteSavedBoundary({
        projectRoot: input.projectRoot,
        draft: context.draft,
        currentCandidate: context.candidate,
        ...(context.progress ? { currentProgress: context.progress } : {}),
        name: selected.boundary_name,
      });
      process.stdout.write([
        `Deleted saved disabled boundary "${selected.boundary_name}".`,
        `Selected boundary: ${result.selected_name}`,
        "Active Explore authority changed: no",
        "",
      ].join("\n"));
      continue;
    }
    if (selected.action === "confirm") {
      if (input.initialView === "access") {
        const activationResult = await confirmActivateAndKeepAccessOpen(input);
        if (activationResult !== 0) return activationResult;
        continue;
      }
      const context = await loadBoundaryReviewContext(input.projectRoot);
      const reviewed = await confirmBoundaryReviewInteractively({
        projectRoot: input.projectRoot,
        context,
        session: input.session,
      });
      if (reviewed.context.bundle.outstanding_decision_ids.length === 0) {
        return boundaryActivateCommand(
          [
            "--project-root", input.projectRoot,
            ...(reviewed.actor ? ["--actor", reviewed.actor] : []),
          ],
          input.schemaInspector,
          input.session,
          input.activationHandoff,
        );
      }
      process.stdout.write(formatBoundaryReviewSummary(reviewed.context.bundle));
      return 0;
    }
    if (selected.action === "disable") {
      return boundaryDisableCommand(
        ["--project-root", input.projectRoot, "--name", selected.boundary_name],
        input.session,
      );
    }
    if (!("resource_id" in selected)) {
      throw new Error("Boundary review returned an unsupported interactive action.");
    }
    selectedResourceId = selected.resource_id;
    // The boundary list is the entry point for /access, not the destination
    // for Back from a table's column editor. Resume at this boundary's table
    // list after any table-level action.
    startAtBoundaryList = false;
    const view = await inspectBoundaryResourceReview(input.projectRoot, selected.resource_id);
    if (selected.action === "privacy") {
      const result = await interactiveMinimumCohortReview({
        projectRoot: input.projectRoot,
        resourceId: selected.resource_id,
        view,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: input.initialView === "access",
      });
      if (result === "review") {
        if (input.initialView === "access") {
          const activationResult = await confirmActivateAndKeepAccessOpen(input);
          if (activationResult !== 0) return activationResult;
        }
        continue;
      }
      if (result !== "back" && result !== 0) return result;
      continue;
    }
    if (selected.action === "signoff") {
      await confirmBoundaryResourceInteractively({
        projectRoot: input.projectRoot,
        context,
        resourceId: selected.resource_id,
        session: input.session,
      });
      continue;
    }
    if (selected.action === "add") {
      const result = await interactiveBoundaryResourceAddition({
        projectRoot: input.projectRoot,
        view,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: input.initialView === "access",
      });
      if (result === "review") {
        if (input.initialView === "access") {
          const activationResult = await confirmActivateAndKeepAccessOpen(input);
          if (activationResult !== 0) return activationResult;
        }
        continue;
      }
      if (result !== "back" && result !== 0) return result;
      continue;
    }
    if (selected.action === "remove") {
      const result = await interactiveBoundaryResourceRemoval({
        projectRoot: input.projectRoot,
        view,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: input.initialView === "access",
      });
      if (result !== 0) return result;
      continue;
    }
    const result = await interactiveBoundaryResourceReview({
      projectRoot: input.projectRoot,
      resourceId: selected.resource_id,
      view,
      schemaInspector: input.schemaInspector,
      session: input.session,
      focusedAccess: input.initialView === "access",
    });
    if (result === "review") {
      if (input.initialView === "access") {
        const activationResult = await confirmActivateAndKeepAccessOpen(input);
        if (activationResult !== 0) return activationResult;
      }
      continue;
    }
    if (result !== "back" && result !== 0) return result;
  }
}

async function interactiveRankedGroupReview(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
}): Promise<number> {
  const context = await loadBoundaryReviewContext(input.projectRoot);
  const current = context.candidate.budgets.max_ranked_groups
    ?? context.candidate.budgets.max_groups;
  const generatedMaximum = context.draft.budgets.max_ranked_groups
    ?? context.draft.budgets.max_groups;
  const entered = await input.session.promptText(
    `Ranked underlying groups [${current}] (${context.candidate.budgets.max_groups}-${generatedMaximum}): `,
  );
  if (entered === undefined) {
    process.stdout.write("Returned to boundary review. The ranked limit was not changed.\n");
    return 0;
  }
  const value = entered.trim() ? Number(entered.trim()) : current;
  if (!Number.isSafeInteger(value)
    || value < context.candidate.budgets.max_groups
    || value > generatedMaximum) {
    process.stdout.write([
      `Use an integer from ${context.candidate.budgets.max_groups} through ${generatedMaximum}.`,
      "This limit controls how many underlying groups a top/bottom query may consider; it does not change the returned top-N.",
      "No boundary setting changed.",
      "",
    ].join("\n"));
    return 0;
  }
  if (value === current) {
    process.stdout.write("The ranked aggregate limit is unchanged.\n");
    return 0;
  }
  const accepted = await input.session.confirm(
    `Allow ranked queries to consider at most ${value} underlying groups while returning at most ${context.candidate.budgets.max_top_n}?`,
    { defaultValue: true },
  );
  if (!accepted) {
    process.stdout.write("The ranked aggregate limit was not changed.\n");
    return 0;
  }
  const resourceId = context.candidate.pack.resources[0]?.id;
  if (!resourceId) throw new Error("A boundary needs one reviewed table before its ranked limit can be changed.");
  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    {
      resource_id: resourceId,
      max_ranked_groups: value,
      actor: localInteractiveActor(),
      reason: "Reviewed the maximum underlying groups for bounded ranked aggregate queries.",
    },
    input.schemaInspector,
  );
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved ranked aggregate limit ${value} in disabled boundary revision ${committed.review_revision}.`,
    `Returned results remain capped at top ${context.candidate.budgets.max_top_n}.`,
    "Suppression runs before ranking. Agent authority changed: no.",
    "",
  ].join("\n"));
  return 0;
}

async function interactiveBoundaryResourceAddition(input: {
  projectRoot: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
}): Promise<number | "back" | "review"> {
  if (input.view.candidate) {
    return interactiveBoundaryResourceReview({
      projectRoot: input.projectRoot,
      resourceId: input.view.resource_id,
      view: input.view,
      schemaInspector: input.schemaInspector,
      session: input.session,
      focusedAccess: input.focusedAccess,
    });
  }
  if (!input.view.generated_candidate) {
    const resolved = await resolveBlockedBoundaryResource({
      projectRoot: input.projectRoot,
      view: input.view,
      schemaInspector: input.schemaInspector,
      session: input.session,
      include: true,
    });
    if (!resolved || resolved === "back") return "back";
    return interactiveBoundaryResourceReview({
      projectRoot: input.projectRoot,
      resourceId: input.view.resource_id,
      view: resolved,
      schemaInspector: input.schemaInspector,
      session: input.session,
      focusedAccess: input.focusedAccess,
    });
  }
  const actor = localInteractiveActor();
  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    {
      resource_id: input.view.resource_id,
      include: true,
      actor,
      reason: "Added explicitly to the disabled boundary before reviewing its column access.",
    },
    input.schemaInspector,
  );
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write(formatFocusedBoundaryEditSaved(
    input.view.resource_id,
    "added",
    committed.review_revision,
  ));

  const addedView = await inspectBoundaryResourceReview(input.projectRoot, input.view.resource_id);
  return interactiveBoundaryResourceReview({
    projectRoot: input.projectRoot,
    resourceId: input.view.resource_id,
    view: addedView,
    schemaInspector: input.schemaInspector,
    session: input.session,
    focusedAccess: input.focusedAccess,
  });
}

async function resolveBlockedBoundaryResource(input: {
  projectRoot: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  include: boolean;
}): Promise<BoundaryResourceReviewView | "back" | undefined> {
  if (!input.session.resolveBlockedResource) {
    process.stdout.write([
      `${input.view.resource_id} still needs a reviewed record ID and tenant-isolation column.`,
      `Run ${cliCommandName()} boundary review in a terminal to choose from database-inspected candidates.`,
      "Nothing was saved or activated.",
      "",
    ].join("\n"));
    return "back";
  }
  const resolution = await input.session.resolveBlockedResource(input.view);
  if (!resolution || resolution === "back") return resolution;
  const sharedReference = "shared_reference_scope" in resolution;
  let reason = "Selected database-inspected identity and tenant isolation in local boundary review.";
  if (sharedReference) {
    while (true) {
      const answer = await input.session.promptText(
        `Why does ${input.view.resource_id} contain the same rows for every tenant? A concrete reason is required; Enter alone does not save`,
      );
      if (answer === undefined) {
        process.stdout.write("Cancelled - no change was made.\n\n");
        return "back";
      }
      if (answer.trim()) {
        reason = answer.trim();
        break;
      }
      process.stdout.write("A reason is required; no change was made.\n");
    }
    const confirmed = await input.session.confirm(
      `Confirm ${input.view.resource_id} has no per-tenant rows and every tenant may receive the same reviewed rows?`,
      { defaultValue: false },
    );
    if (confirmed !== true) {
      process.stdout.write("Cancelled - no change was made.\n\n");
      return "back";
    }
  }
  try {
    const preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      {
        resource_id: input.view.resource_id,
        ...(input.include ? { include: true } : {}),
        row_identity: resolution.row_identity,
        ...(resolution.tenant_key
          ? { tenant_key: resolution.tenant_key }
          : resolution.tenant_scope_path
            ? { tenant_scope_path: resolution.tenant_scope_path }
            : { shared_reference_scope: SHARED_REFERENCE_ACKNOWLEDGEMENT }),
        actor: localInteractiveActor(),
        reason,
      },
      input.schemaInspector,
    );
    const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
    const derivedTenantScope = resolution.tenant_scope_path
      ? input.view.derived_tenant_scope?.candidates.find((scope) =>
        scope.path_id === resolution.tenant_scope_path)
      : undefined;
    process.stdout.write([
      `Saved structural review for ${input.view.resource_id} in disabled boundary revision ${committed.review_revision}.`,
      `Record ID: ${resolution.row_identity}`,
      resolution.tenant_key
        ? `Tenant isolation: ${resolution.tenant_key} (direct column; trusted value stays outside model arguments)`
        : resolution.tenant_scope_path
          ? `Tenant isolation: ${derivedTenantScope
            ? formatDerivedScopePath(derivedTenantScope)
            : resolution.tenant_scope_path} (mandatory relationship path; trusted value stays outside model arguments)`
          : "Row scope: Shared reference (no tenant predicate; field, privacy, and budget controls still apply)",
      "Agent authority activated: no",
      "Review column access next.",
      "",
    ].join("\n"));
    return inspectBoundaryResourceReview(input.projectRoot, input.view.resource_id);
  } catch (error) {
    process.stdout.write([
      `This table was not added: ${redactCliErrorMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
      "You are still in boundary review. Nothing was saved or activated.",
      "",
    ].join("\n"));
    return "back";
  }
}

async function confirmActivateAndKeepAccessOpen(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  activationHandoff?: BoundaryActivationHandoff;
  activationReviewNotice?: BoundaryReviewCommandOptions["activationReviewNotice"];
}): Promise<number> {
  const result = await confirmAndActivateFocusedBoundary({
    ...input,
    keepAccessOpen: true,
  });
  if (result !== 0) return result;
  process.stdout.write([
    "/access is still open.",
    "Continue setting up this boundary, switch boundaries, or press Q/Esc when finished to return to Ask.",
    "",
  ].join("\n"));
  return 0;
}

async function confirmAndActivateFocusedBoundary(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  activationHandoff?: BoundaryActivationHandoff;
  activationReviewNotice?: BoundaryReviewCommandOptions["activationReviewNotice"];
  keepAccessOpen?: boolean;
}): Promise<number> {
  let context = await loadBoundaryReviewContext(input.projectRoot);
  const boundaryLibrary = await synchronizeBoundaryLibrary({
    projectRoot: input.projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
  });
  const selectedBoundary = boundaryLibrary.entries.find((entry) => entry.selected);
  if (selectedBoundary?.active && selectedBoundary.matches_active_digest) {
    process.stdout.write([
      `Boundary "${selectedBoundary.name}" has no access changes to review.`,
      "Reviewed authority and provider egress are unchanged.",
      input.keepAccessOpen
        ? "Continue reviewing access, or press Q/Esc when finished to return to Ask."
        : "Returning to Ask.",
      "",
    ].join("\n"));
    return 0;
  }
  if (!context.candidate.pack.resources.length) {
    throw new Error("A boundary must contain at least one reviewed table before activation.");
  }
  while (true) {
    const unresolvedRelationship = context.candidate.pack.resources
      .flatMap((resource) => resource.relationships.map((relationship) => ({
        resource: resource.id,
        relationship,
      })))
      .find(({ relationship }) => relationship.unmatched_rows === "review_required");
    if (!unresolvedRelationship) break;
    process.stdout.write([
      "",
      "ONE RELATIONSHIP CHOICE",
      `${unresolvedRelationship.resource} -> ${unresolvedRelationship.relationship.target_resource}`,
      "Some counted rows may not have a related record. This choice changes analytical totals.",
      "K  Keep the counted row and show an empty group value",
      "E  Exclude the counted row from analyses using this relationship",
      "",
    ].join("\n"));
    let answer = "";
    while (!["k", "keep", "e", "exclude", "q", "quit"].includes(answer)) {
      const entered = await input.session.promptText("Choose K or E (Q cancels): ");
      if (entered === undefined) {
        answer = "q";
        break;
      }
      answer = entered.trim().toLowerCase();
    }
    if (answer === "q" || answer === "quit") {
      process.stdout.write([
        "The edited boundary remains disabled. Current agent authority is unchanged.",
        input.keepAccessOpen
          ? "Continue reviewing access, or press Q/Esc when finished to return to Ask."
          : `Resume: ${cliCommandName()} boundary review --access`,
        "",
      ].join("\n"));
      return 0;
    }
    const unmatchedRows = answer === "k" || answer === "keep" ? "keep_null" : "exclude";
    const preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      {
        resource_id: unresolvedRelationship.resource,
        nullable_relationship: {
          relationship_id: unresolvedRelationship.relationship.id,
          unmatched_rows: unmatchedRows,
        },
        actor: localInteractiveActor(),
        reason: unmatchedRows === "keep_null"
          ? "Keep counted rows with no related record under an empty group in the focused access review."
          : "Exclude counted rows with no related record from analyses using this relationship in the focused access review.",
      },
      input.schemaInspector,
    );
    await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
    process.stdout.write(
      `Saved on the disabled boundary: unmatched rows will ${
        unmatchedRows === "keep_null" ? "remain under an empty group" : "be excluded"
      }.\n`,
    );
    context = await loadBoundaryReviewContext(input.projectRoot);
  }
  process.stdout.write(formatFocusedBoundaryActivationReview(
    context.bundle,
    process.stdout.isTTY === true && !("NO_COLOR" in process.env),
  ));
  const activationReviewNotice = input.activationReviewNotice?.({
    projectRoot: input.projectRoot,
    boundaryName: context.candidate.pack.name,
    boundaryDigest: context.bundle.candidate_digest,
  });
  if (activationReviewNotice) {
    process.stdout.write(
      activationReviewNotice.endsWith("\n")
        ? activationReviewNotice
        : `${activationReviewNotice}\n`,
    );
  }
  const actor = localInteractiveActor();
  const accepted = await input.session.confirm(
    context.candidate.deployment_profile === "production"
      ? input.keepAccessOpen
        ? `Activate "${context.candidate.pack.name}" exactly as shown for secured production HTTP Explore now? You will stay in /access.`
        : `Activate "${context.candidate.pack.name}" exactly as shown for secured production HTTP Explore?`
      : input.keepAccessOpen
        ? `Activate "${context.candidate.pack.name}" exactly as shown now? You will stay in /access.`
        : `Activate "${context.candidate.pack.name}" exactly as shown and continue to Ask?`,
    { defaultValue: true },
  );
  if (!accepted) {
    process.stdout.write([
      "The edited boundary remains disabled. Current agent authority is unchanged.",
      input.keepAccessOpen
        ? "Continue reviewing access, or press Q/Esc when finished to return to Ask."
        : `Resume: ${cliCommandName()} boundary review --access`,
      "",
    ].join("\n"));
    return 0;
  }
  const progress = createBoundaryReviewProgress({
    draft: context.draft,
    candidate: context.candidate,
    confirmedDecisions: context.candidate.unresolved_decisions,
    ...(context.progress ? { previous: context.progress } : {}),
    actor,
    reason: "Confirmed the complete exact boundary shown by the focused access editor.",
    revision: (context.progress?.revision ?? 0) + 1,
  });
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  return boundaryActivateCommand(
    [
      "--project-root", input.projectRoot,
      "--confirm", `ACTIVATE ${progress.candidate_digest}`,
      "--actor", actor,
    ],
    input.schemaInspector,
    input.session,
    input.activationHandoff,
  );
}

export function formatFocusedBoundaryActivationReview(
  bundle: BoundaryReviewBundle,
  color = false,
): string {
  const theme = terminalTheme(color);
  const accessRows = bundle.candidate.pack.resources.flatMap((resource, index) => {
    const modelFields = resource.selectable_fields.filter(
      (field) => !(resource.model_withheld_fields ?? []).includes(field),
    );
    const relationships = resource.relationships.map(
      (relationship) => `${relationship.target_resource} (${relationship.cardinality.replaceAll("_", "-")})`,
    );
    const reviewedValues = Object.entries(resource.field_enums).map(
      ([field, values]) => `${field}: ${values.join(" | ")}`,
    );
    return [
      ...(index === 0 ? [] : [["", ""]]),
      ["Table", resource.id],
      ["Model + Runner", fieldList(modelFields)],
      ["Runner only", fieldList(resource.model_withheld_fields ?? [])],
      ["Kept out", fieldList(resource.kept_out_fields)],
      ["Value allowlists", reviewedValues.length ? reviewedValues.join("; ") : "None"],
      ["Reviewed links", relationships.length ? relationships.join(", ") : "None"],
    ];
  });
  const directTenantKeys = [...new Set(bundle.candidate.pack.resources
    .map((resource) => resource.tenant_key)
    .filter((value): value is string => Boolean(value)))];
  const allTenantScopesDirect = bundle.candidate.pack.resources.every(
    (resource) => Boolean(resource.tenant_key),
  );
  const tenantBinding = bundle.candidate.organization_scope
    ? `fixed reviewed organization ${bundle.candidate.organization_scope.organization_id}`
    : bundle.candidate.trusted_context.provider === "http_claims"
    ? `verified JWT claim ${bundle.candidate.trusted_context.tenant_claim}`
    : bundle.candidate.trusted_context.database_role_tenant
      ? `database role ${bundle.candidate.trusted_context.database_role_tenant.setting}`
      : bundle.candidate.trusted_context.tenant_env;
  const principalScopes = bundle.candidate.pack.resources
    .filter((resource) => Boolean(resource.principal_key || resource.principal_scope))
    .map((resource) => resource.principal_key
      ? `${resource.id}.${resource.principal_key}`
      : `${resource.id} through ${formatDerivedScopePath(resource.principal_scope!)}`);
  const tenantScopeSummary = bundle.candidate.organization_scope
    ? `Single organization (${bundle.candidate.organization_scope.organization_id}); no tenant predicate is applied`
    : allTenantScopesDirect && directTenantKeys.length === 1
      ? `${directTenantKeys[0]} on every table via ${tenantBinding}`
      : bundle.candidate.pack.resources.map((resource) =>
        resource.shared_reference_scope
          ? `${resource.id} Shared reference (no tenant predicate)`
          : `${resource.id} ${reviewedTenantScopeLabel(resource)} via ${tenantBinding}`)
        .join("; ");
  const principalBinding = bundle.candidate.trusted_context.provider === "http_claims"
    ? `verified JWT claim ${bundle.candidate.trusted_context.principal_claim}`
    : bundle.candidate.trusted_context.principal_env;
  const principalScopeSummary = principalScopes.length
    ? `Row filtering required for ${principalScopes.join(", ")} via ${principalBinding}`
    : bundle.candidate.deployment_profile === "production"
      ? `Required for per-user privacy budgets via ${principalBinding}; no reviewed principal row column`
      : "Not required for this boundary";
  const accessTable = formatTextTable(
    ["REVIEWED ACCESS", "VALUE"],
    accessRows,
    [20, 76],
  );
  const limitsTable = formatTextTable(
    ["LIMIT", "REVIEWED VALUE"],
    [
      ["Tenant scope", tenantScopeSummary],
      ["Principal scope", principalScopeSummary],
      [
        "Small-group privacy",
        `Minimum group sizes: ${bundle.candidate.pack.resources.map(
          (resource) => `${resource.id}=${resource.minimum_cohort_size}${
            resource.minimum_cohort_overridden ? " (owner override)" : ""
          }`,
        ).join(", ")}`,
      ],
      [
        "Ranked aggregates",
        `Validate at most ${bundle.candidate.budgets.max_ranked_groups
          ?? bundle.candidate.budgets.max_groups} candidate groups, suppress small cohorts, ` +
        `then return at most top ${bundle.candidate.budgets.max_top_n}`,
      ],
      [
        "Writes",
        bundle.candidate.deployment_profile === "production"
          ? "None - this boundary is read-only production Explore"
          : "None - this boundary is local read-only Explore",
      ],
    ],
    [22, 76],
  );
  return [
    "",
    theme.title("REVIEW EXACT BOUNDARY"),
    `${theme.bold("Boundary:")} ${theme.scope(bundle.candidate.pack.name)}`,
    theme.dim("This is the only human authority confirmation. Runner will recheck the schema and read-only role before activation."),
    "",
    ...styleReviewTable(accessTable, theme),
    "",
    ...styleReviewTable(limitsTable, theme),
    "",
    `${theme.bold("Exact fingerprint:")} ${theme.scope(bundle.candidate_digest)}`,
    theme.success("Source database changed: no. The model cannot perform this confirmation."),
    "",
  ].join("\n");
}

function styleReviewTable(lines: string[], theme: ReturnType<typeof terminalTheme>): string[] {
  const separator = lines[1] ?? "";
  const splitAt = separator.indexOf("  ");
  if (splitAt < 0) return lines.map((line, index) =>
    index === 0 ? theme.bold(line) : index === 1 ? theme.dim(line) : theme.value(line));
  let activeLabel = "";
  return lines.map((line, index) => {
    if (index === 0) {
      return `${theme.title(line.slice(0, splitAt))}  ${theme.bold(line.slice(splitAt + 2))}`;
    }
    if (index === 1) return theme.dim(line);
    if (!line.trim()) {
      activeLabel = "";
      return line;
    }
    const labelCell = line.slice(0, splitAt);
    const valueCell = line.slice(splitAt + 2);
    const label = labelCell.trim();
    if (label) activeLabel = label;
    return `${label ? theme.key(labelCell) : labelCell}  ${styleReviewValue(valueCell, activeLabel, theme)}`;
  });
}

function styleReviewValue(
  value: string,
  label: string,
  theme: ReturnType<typeof terminalTheme>,
): string {
  if (label === "Table" || label === "Tenant scope" || label === "Principal scope") {
    return theme.scope(value);
  }
  if (label === "Model + Runner") return theme.visible(value);
  if (label === "Runner only") return theme.runnerOnly(value);
  if (label === "Kept out") return theme.keptOut(value);
  if (label === "Value allowlists" || label === "Reviewed links") {
    return theme.relationship(value);
  }
  if (label === "Small-group privacy") return theme.warning(value);
  if (label === "Writes") return theme.success(value);
  return theme.value(value);
}

function localInteractiveActor(): string {
  const value = process.env.SYNAPSOR_OPERATOR_ID?.trim()
    || process.env.USER?.trim()
    || "local-developer";
  if (value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return "local-developer";
}

async function interactiveBoundaryRename(input: {
  projectRoot: string;
  session: BoundaryReviewInteractiveSession;
}): Promise<number> {
  const context = await loadBoundaryReviewContext(input.projectRoot);
  const currentName = context.candidate.pack.name;
  const requestedName = await input.session.promptText(
    `Boundary name [${currentName}] (letters, numbers, dot, dash, underscore): `,
  );
  if (requestedName === undefined) {
    process.stdout.write("Returned to boundary review. The boundary name was not changed.\n");
    return 0;
  }
  const nextName = requestedName ? requestedName.trim().toLowerCase() : currentName;
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(nextName)) {
    process.stdout.write([
      "Boundary name was not changed.",
      "Use 1-64 letters, numbers, dots, dashes, or underscores; start with a letter.",
      "You are still in boundary review. Active authority and Ask access are unchanged.",
      "",
    ].join("\n"));
    return 0;
  }
  if (requestedName && nextName !== requestedName.trim()) {
    process.stdout.write(`Using lower-case boundary name "${nextName}".\n`);
  }
  if (nextName === currentName) {
    process.stdout.write("Boundary name was not changed. Nothing was saved or activated.\n");
    return 0;
  }
  const actor = await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write("Returned to boundary review. The boundary name was not changed.\n");
    return 0;
  }
  const reason = await input.session.promptText("Reason for naming this boundary: ");
  if (!reason) {
    process.stdout.write([
      "Boundary name was not changed. A reviewer identity and reason are required.",
      "You are still in boundary review. Active authority and Ask access are unchanged.",
      "",
    ].join("\n"));
    return 0;
  }
  const candidate = structuredClone(context.candidate);
  candidate.pack.name = nextName;
  const reviewed = reviewExplorationBoundaryCandidate(context.draft, candidate);
  process.stdout.write([
    "",
    "DISABLED BOUNDARY NAME CHANGE",
    `  Before: ${currentName}`,
    `  After:  ${nextName}`,
    `  Tables retained: ${reviewed.candidate.pack.resources.length}`,
    `  Candidate fingerprint: ${reviewed.digest}`,
    "  Active authority changed: no",
    "  Source database changed: no",
    "",
  ].join("\n"));
  if (!await input.session.confirm(
    "Save this name on the disabled next boundary now?",
    { defaultValue: true },
  )) {
    process.stdout.write("Boundary name change discarded. Nothing was saved or activated.\n");
    return 0;
  }
  const progress = await renameSavedBoundary({
    projectRoot: input.projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
    name: currentName,
    newName: nextName,
    actor,
    reason,
  });
  process.stdout.write([
    `Saved boundary name "${nextName}" in review revision ${progress.revision}.`,
    `Next boundary contains ${progress.candidate.pack.resources.length} ` +
      `${progress.candidate.pack.resources.length === 1 ? "table" : "tables"}.`,
    "Authority activated: no",
    `Next: ${cliCommandName()} boundary review`,
    "",
  ].join("\n"));
  return 0;
}

async function confirmBoundaryReviewInteractively(input: {
  projectRoot: string;
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  session: BoundaryReviewInteractiveSession;
  actor?: string;
}): Promise<{
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  actor?: string;
}> {
  const outstanding = input.context.bundle.decisions.filter((decision) => !decision.confirmed);
  if (!outstanding.length) {
    return { context: input.context, actor: input.actor };
  }
  process.stdout.write(formatBoundaryFinalReview(input.context.bundle));
  const actor = input.actor
    || await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write([
      "Returned to boundary review. No sign-offs were recorded.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return { context: input.context };
  }
  const confirmed = new Set(input.context.progress?.confirmed_decisions ?? []);
  let acceptedGroups = 0;
  const boundaryDecisions = outstanding.filter((decision) => !decision.resource_id);
  if (boundaryDecisions.length) {
    process.stdout.write(formatBoundarySettingsSignoff(input.context.bundle));
    const accepted = await input.session.confirm(
      input.context.candidate.deployment_profile === "production"
        ? "Confirm these boundary-wide production HTTP and trusted JWT scope settings?"
        : "Confirm these boundary-wide local-authoring and trusted-scope settings?",
      { defaultValue: true },
    );
    if (accepted === undefined) {
      process.stdout.write("Returned to boundary review. No sign-offs were recorded.\n");
      return { context: input.context, actor };
    }
    if (accepted) {
      boundaryDecisions.forEach((decision) => confirmed.add(decision.decision));
      acceptedGroups += 1;
    }
  }
  for (const resource of input.context.candidate.pack.resources) {
    const decisions = outstanding.filter((decision) => decision.resource_id === resource.id);
    if (!decisions.length) continue;
    process.stdout.write(formatBoundaryResourceSignoff(resource, decisions.length));
    const accepted = await input.session.confirm(
      `Sign off ${resource.id} exactly as shown?`,
      { defaultValue: true },
    );
    if (accepted === undefined) {
      process.stdout.write("Returned to boundary review. No sign-offs from this review were recorded.\n");
      return { context: input.context, actor };
    }
    if (accepted) {
      decisions.forEach((decision) => confirmed.add(decision.decision));
      acceptedGroups += 1;
    }
  }
  if (!acceptedGroups) {
    process.stdout.write([
      "No review sign-offs were recorded.",
      "The disabled draft remains unchanged and grants no agent access.",
      `Next: ${cliCommandName()} boundary review`,
      "",
    ].join("\n"));
    return { context: input.context, actor };
  }
  const progress = createBoundaryReviewProgress({
    draft: input.context.draft,
    candidate: input.context.candidate,
    confirmedDecisions: [...confirmed],
    previous: input.context.progress,
    actor,
    reason: "Confirmed through the grouped CLI boundary review shown to this operator.",
    revision: (input.context.progress?.revision ?? 0) + 1,
  });
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  return {
    context: await loadBoundaryReviewContext(input.projectRoot),
    actor,
  };
}

async function confirmBoundaryResourceInteractively(input: {
  projectRoot: string;
  resourceId: string;
  session: BoundaryReviewInteractiveSession;
  context?: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
}): Promise<Awaited<ReturnType<typeof loadBoundaryReviewContext>>> {
  const context = input.context ?? await loadBoundaryReviewContext(input.projectRoot);
  const resource = context.candidate.pack.resources.find(
    (candidate) => candidate.id === input.resourceId,
  );
  if (!resource) {
    throw new Error(
      `${input.resourceId} is not in the disabled next boundary; include it before signing it off.`,
    );
  }
  const outstanding = context.bundle.decisions.filter(
    (decision) => decision.resource_id === input.resourceId && !decision.confirmed,
  );
  if (!outstanding.length) {
    process.stdout.write([
      `${input.resourceId} is already signed off for the current disabled boundary fingerprint.`,
      "No authority or source data changed.",
      "",
    ].join("\n"));
    return context;
  }
  process.stdout.write(formatBoundaryResourceSignoff(resource, outstanding.length));
  const actor = await input.session.promptText(
    "Human reviewer identity (audit label, not a password): ",
  );
  if (!actor) {
    process.stdout.write([
      "Returned to boundary review. Table sign-off was not recorded.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return context;
  }
  if (!await input.session.confirm(
    `Sign off ${input.resourceId} exactly as shown?`,
    { defaultValue: true },
  )) {
    process.stdout.write([
      "Table sign-off was not recorded.",
      "The disabled draft remains unchanged and grants no agent access.",
      "",
    ].join("\n"));
    return context;
  }
  const progress = createBoundaryReviewProgress({
    draft: context.draft,
    candidate: context.candidate,
    confirmedDecisions: [
      ...(context.progress?.confirmed_decisions ?? []),
      ...outstanding.map((decision) => decision.decision),
    ],
    previous: context.progress,
    actor,
    reason: `Confirmed the grouped CLI review for ${input.resourceId}.`,
    revision: (context.progress?.revision ?? 0) + 1,
  });
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  const updated = await loadBoundaryReviewContext(input.projectRoot);
  const remaining = boundaryReviewOverview(updated.bundle);
  process.stdout.write([
    `Signed off ${input.resourceId}.`,
    `${outstanding.length} digest-bound ${outstanding.length === 1 ? "decision is" : "decisions are"} now recorded under one table sign-off.`,
    `Review left: ${formatReviewLeft(remaining)}.`,
    "Authority activated: no",
    `Next: ${cliCommandName()} boundary review`,
    "",
  ].join("\n"));
  return updated;
}

async function interactiveBoundaryResourceRemoval(input: {
  projectRoot: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
}): Promise<number> {
  if (!input.view.candidate) {
    process.stdout.write(`${input.view.resource_id} is not included. Nothing was changed.\n`);
    return 0;
  }
  const actor = input.focusedAccess
    ? localInteractiveActor()
    : await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write([
      "Returned to boundary review. Table removal was not saved.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return 0;
  }
  const reason = input.focusedAccess
    ? "Staged through the focused access editor; this exact boundary revision requires final human confirmation."
    : await input.session.promptText("Reason for removing this table from the boundary: ");
  if (!reason) {
    process.stdout.write([
      "Returned to boundary review. Table removal was not saved.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return 0;
  }
  const request: BoundaryResourceReviewRequest = {
    resource_id: input.view.resource_id,
    exclude: true,
    actor,
    reason,
  };
  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    request,
    input.schemaInspector,
  );
  if (!input.focusedAccess) {
    process.stdout.write(formatBoundaryMutationPreview(preview, input.view));
    if (!await input.session.confirm(
      "Save this table removal on the disabled next boundary now?",
      { defaultValue: true },
    )) {
      process.stdout.write("Table removal discarded. Nothing was saved or activated.\n");
      return 0;
    }
  }
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write(input.focusedAccess
    ? formatFocusedBoundaryEditSaved(input.view.resource_id, "removed", committed.review_revision)
    : formatBoundaryMutationCommit(
      input.projectRoot,
      committed.review_revision,
      committed.candidate_digest,
      actor,
    ));
  return 0;
}

async function interactiveBoundaryResourceReview(input: {
  projectRoot: string;
  resourceId: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
  initialTiers?: Record<string, BoundaryFieldTier>;
}): Promise<number | "back" | "review"> {
  if (!input.view.candidate && !input.view.generated_candidate) {
    const resolved = await resolveBlockedBoundaryResource({
      projectRoot: input.projectRoot,
      view: input.view,
      schemaInspector: input.schemaInspector,
      session: input.session,
      include: true,
    });
    if (!resolved || resolved === "back") return "back";
    return interactiveBoundaryResourceReview({ ...input, view: resolved });
  }
  const selected = await input.session.editFieldTiers(input.view, {
    focusedAccess: input.focusedAccess === true,
    ...(input.initialTiers ? { initialTiers: input.initialTiers } : {}),
  });
  if (selected === "back") return "back";
  if (selected === "privacy") return interactiveMinimumCohortReview(input);
  if (isEnumFieldTierAction(selected)) {
    const enumResult = await interactiveBoundaryEnumReview({
      ...input,
      field: selected.field,
      stagedTiers: selected.tiers,
    });
    if (enumResult === "saved") {
      const updatedView = await inspectBoundaryResourceReview(input.projectRoot, input.resourceId);
      return interactiveBoundaryResourceReview({
        ...input,
        view: updatedView,
        initialTiers: undefined,
      });
    }
    if (enumResult === "columns") {
      return interactiveBoundaryResourceReview({
        ...input,
        initialTiers: selected.tiers,
      });
    }
    return enumResult;
  }
  if (typeof selected === "string") {
    if (selected.startsWith("enum:")) {
      const enumResult = await interactiveBoundaryEnumReview({
        ...input,
        field: selected.slice("enum:".length),
      });
      if (enumResult === "saved") {
        const updatedView = await inspectBoundaryResourceReview(input.projectRoot, input.resourceId);
        return interactiveBoundaryResourceReview({ ...input, view: updatedView });
      }
      if (enumResult === "columns") return interactiveBoundaryResourceReview(input);
      return enumResult;
    }
    throw new Error(`Unsupported column review action: ${selected}.`);
  }
  if (!selected) {
    process.stdout.write("Cancelled - no column access change was made or activated.\n");
    return 0;
  }
  const selectedTiers = selected as Record<string, BoundaryFieldTier>;
  const changed = changedFieldTiers(input.view, selectedTiers);
  const includeResource = !input.view.candidate && Boolean(input.view.generated_candidate);
  if (!changed.length && !includeResource) {
    if (input.focusedAccess) {
      process.stdout.write([
        `Unchanged: ${input.resourceId} already has the access levels shown; no change was made.`,
        "Agent authority is unchanged.",
        "",
      ].join("\n"));
      return "back";
    }
    await confirmBoundaryResourceInteractively({
      projectRoot: input.projectRoot,
      resourceId: input.resourceId,
      session: input.session,
    });
    return "back";
  }
  const explicitReasonRequired = input.focusedAccess
    && focusedEditNeedsExplicitReason(input.view, changed);
  const trustedScopeChange = changed.some(({ field }) => {
    const candidate = input.view.candidate ?? input.view.generated_candidate;
    return field === candidate?.tenant_key || field === candidate?.principal_key;
  });
  const actor = input.focusedAccess
    ? localInteractiveActor()
    : await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write([
      "Returned to column review. This access change was not saved.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return input.focusedAccess ? "back" : 0;
  }
  let reason: string | undefined;
  if (explicitReasonRequired) {
    const auditedChanges = changed.map(({ field, tier }) =>
      `${input.resourceId}.${field} -> ${focusedTierOutcome(tier)}`);
    const reviewedChangeLabel = trustedScopeChange ? "trusted-scope" : "sensitive-field";
    process.stdout.write([
      `This widens ${reviewedChangeLabel} access:`,
      ...auditedChanges.map((change) => `  ${change}`),
      `Reviewer: ${actor}`,
      "A concrete reason is required before Runner can save this change.",
      "Pressing Enter with an empty reason will not apply the change.",
      "",
    ].join("\n"));
    const prompt = `Required reason for this ${reviewedChangeLabel} access change`;
    while (reason === undefined) {
      const entered = await input.session.promptText(`${prompt}: `);
      if (entered === undefined) {
        process.stdout.write(`Cancelled - no ${reviewedChangeLabel} access change was made.\n\n`);
        return input.focusedAccess ? "back" : 0;
      }
      if (!entered.trim()) {
        process.stdout.write([
          "Rejected: a concrete reason is required; no change was made.",
          "Enter the reason now, or press Esc to cancel.",
          "",
        ].join("\n"));
        continue;
      }
      reason = entered.trim();
    }
  } else {
    reason = input.focusedAccess
      ? "Staged through the focused access editor; this exact boundary revision requires final human confirmation."
      : await input.session.promptText("Reason for this access decision: ");
  }
  if (!reason) {
    process.stdout.write([
      "Returned to column review. This access change was not saved.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return input.focusedAccess ? "back" : 0;
  }
  const request: BoundaryResourceReviewRequest = {
    resource_id: input.resourceId,
    ...(includeResource ? { include: true } : {}),
    keep_out_fields: changed.filter((item) => item.tier === "kept_out").map((item) => item.field),
    withhold_from_model_fields: changed
      .filter((item) => item.tier === "withheld_from_model")
      .map((item) => item.field),
    allow_reviewed_fields: changed.filter((item) => item.tier === "visible").map((item) => item.field),
    actor,
    reason,
  };
  let preview: BoundaryReviewMutationPreview;
  try {
    preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      request,
      input.schemaInspector,
    );
  } catch (error) {
    if (!input.focusedAccess) throw error;
    process.stdout.write([
      `Rejected: ${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}`,
      "No boundary change was made or activated.",
      "",
    ].join("\n"));
    return "back";
  }
  if (!input.focusedAccess) {
    process.stdout.write(formatBoundaryMutationPreview(preview, input.view));
    if (!await input.session.confirm(
      "Save this disabled review decision now?",
      { defaultValue: true },
    )) {
      process.stdout.write("Review decision discarded. Nothing was saved or activated.\n");
      return 0;
    }
  }
  let committed: Awaited<ReturnType<typeof commitBoundaryResourceReviewMutation>>;
  try {
    committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  } catch (error) {
    if (!input.focusedAccess) throw error;
    process.stdout.write([
      `Rejected: ${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}`,
      "No boundary change was made or activated.",
      "",
    ].join("\n"));
    return "back";
  }
  process.stdout.write(input.focusedAccess
    ? [
      formatFocusedBoundaryEditSaved(
        input.resourceId,
        includeResource ? "added" : "updated",
        committed.review_revision,
      ).trimEnd(),
      ...changed.map(({ field, tier }) =>
        `Recorded: ${input.resourceId}.${field} -> ${focusedTierOutcome(tier)}; actor=${actor}; reason=${JSON.stringify(reason)}`),
      ...(changed.some(({ tier }) => tier === "withheld_from_model")
        ? [
          "Access-level note: Runner only controls where raw values can appear; it does not grant Group, Total/Average, or Count unique.",
          "If an operation was refused, review that operation separately in Workbench Advanced field operations or with --group-fields, --measure-fields, or --count-distinct-fields.",
        ]
        : []),
      "",
    ].join("\n")
    : formatBoundaryMutationCommit(
      input.projectRoot,
      committed.review_revision,
      committed.candidate_digest,
      actor,
    ));
  return input.focusedAccess ? "back" : 0;
}

function isEnumFieldTierAction(value: unknown): value is {
  action: "enum";
  field: string;
  tiers: Record<string, BoundaryFieldTier>;
} {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { action?: unknown }).action === "enum"
    && typeof (value as { field?: unknown }).field === "string"
    && Boolean((value as { tiers?: unknown }).tiers)
    && typeof (value as { tiers?: unknown }).tiers === "object"
    && !Array.isArray((value as { tiers?: unknown }).tiers);
}

async function interactiveBoundaryEnumReview(input: {
  projectRoot: string;
  resourceId: string;
  field: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
  stagedTiers?: Record<string, BoundaryFieldTier>;
}): Promise<number | "columns" | "saved"> {
  const inspectedField = input.view.fields.find((field) => field.name === input.field);
  const schemaValues = inspectedField?.enum_values;
  const candidate = input.view.candidate ?? input.view.generated_candidate;
  if (!inspectedField || !schemaValues?.length || !candidate) {
    process.stdout.write(
      `Unchanged: ${input.resourceId}.${input.field} has no bounded database-declared value list to review.\n`,
    );
    return "columns";
  }
  if (!input.session.editFieldEnumValues) {
    throw new Error("This terminal session cannot edit reviewed categorical values.");
  }
  const selected = await input.session.editFieldEnumValues(input.view, input.field);
  if (selected === "back") return "columns";
  if (!selected) {
    process.stdout.write("Cancelled - no allowed-value change was made or activated.\n");
    return "columns";
  }
  const current = Object.hasOwn(candidate.field_enums, input.field)
    ? candidate.field_enums[input.field] ?? []
    : inspectedField.enum_review_override
      ? []
      : schemaValues;
  if (JSON.stringify(current) === JSON.stringify(selected)) {
    process.stdout.write([
      `Unchanged: ${input.resourceId}.${input.field} already uses these allowed values.`,
      "Agent authority is unchanged.",
      "",
    ].join("\n"));
    return "columns";
  }

  const changedTiers = input.stagedTiers
    ? changedFieldTiers(input.view, input.stagedTiers)
    : [];

  const actor = input.focusedAccess
    ? localInteractiveActor()
    : await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write("Cancelled - no allowed-value change was made or activated.\n");
    return "columns";
  }
  process.stdout.write([
    `Reviewing allowed values for ${input.resourceId}.${input.field}.`,
    `Database-declared maximum: ${schemaValues.join(", ")}`,
    `Values to keep: ${selected.length ? selected.join(", ") : "none"}`,
    ...(changedTiers.length
      ? [
          "After you enter the required reason, these column access changes will be saved with the allowed-value review:",
          ...changedTiers.map(({ field, tier }) =>
            `  ${input.resourceId}.${field} -> ${focusedTierOutcome(tier)}`),
        ]
      : []),
    selected.length
      ? "Removed values will be refused before a source query, even if an AI guesses them."
      : "Keeping none disables filtering and grouping for this column; it does not enable free-text access.",
    `Reviewer: ${actor}`,
    "A concrete reason is required. Pressing Enter with an empty reason will not save the change.",
    "",
  ].join("\n"));
  let reason: string | undefined;
  while (reason === undefined) {
    const entered = await input.session.promptText("Required reason for this allowed-value change: ");
    if (entered === undefined) {
      process.stdout.write("Cancelled - no allowed-value change was made or activated.\n");
      return "columns";
    }
    if (!entered.trim()) {
      process.stdout.write([
        "Rejected: a concrete reason is required; no change was made.",
        "Enter the reason now, or press Esc to cancel.",
        "",
      ].join("\n"));
      continue;
    }
    reason = entered.trim();
  }

  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    {
      resource_id: input.resourceId,
      ...(!input.view.candidate && input.view.generated_candidate ? { include: true } : {}),
      keep_out_fields: changedTiers
        .filter((item) => item.tier === "kept_out")
        .map((item) => item.field),
      withhold_from_model_fields: changedTiers
        .filter((item) => item.tier === "withheld_from_model")
        .map((item) => item.field),
      allow_reviewed_fields: changedTiers
        .filter((item) => item.tier === "visible")
        .map((item) => item.field),
      field_enum: { field: input.field, values: selected },
      actor,
      reason,
    },
    input.schemaInspector,
  );
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Recorded: ${input.resourceId}.${input.field} allowed values -> ${selected.length ? selected.join(" | ") : "none (filtering and grouping disabled)"}.`,
    ...changedTiers.map(({ field, tier }) =>
      `Recorded: ${input.resourceId}.${field} -> ${focusedTierOutcome(tier)}.`),
    `Actor: ${actor}. Reason: ${reason}`,
    `Saved in disabled boundary revision ${committed.review_revision}. Agent authority changed: no.`,
    "The active Ask session keeps using the previous boundary until this revision is reviewed and activated.",
    "",
  ].join("\n"));
  return "saved";
}

async function interactiveMinimumCohortReview(input: {
  projectRoot: string;
  resourceId: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
}): Promise<number | "back" | "review"> {
  const candidate = input.view.candidate ?? input.view.generated_candidate;
  if (!candidate) return "back";
  process.stdout.write([
    "",
    `PRIVACY - ${input.resourceId}`,
    `Current minimum group size: ${candidate.minimum_cohort_size}`,
    "Runner hides aggregate groups with fewer rows than this number.",
    "Enter a whole number from 1 through 5. Use 1 to turn small-group suppression off.",
    "",
  ].join("\n"));
  const enteredInput = await input.session.promptText(
    `New minimum group size [current ${candidate.minimum_cohort_size}]: `,
  );
  if (enteredInput === undefined) return "back";
  const entered = enteredInput.trim().toLowerCase();
  if (!entered) return "back";
  const minimumCohort = entered === "off" || entered === "none" || entered === "0"
    ? 1
    : Number(entered);
  if (!Number.isSafeInteger(minimumCohort) || minimumCohort < 1 || minimumCohort > 5) {
    throw new Error(
      "Enter a whole number from 1 through 5. Use 1 to turn small-group suppression off.",
    );
  }
  if (minimumCohort === candidate.minimum_cohort_size) {
    process.stdout.write("The minimum group size is unchanged.\n");
    return "back";
  }
  const reasonInput = await input.session.promptText(
    `Reason for changing ${input.resourceId} from ${candidate.minimum_cohort_size} to ${minimumCohort} (recorded with this decision): `,
  );
  if (reasonInput === undefined) {
    process.stdout.write("Returned to column review. The minimum group size was not changed.\n");
    return "back";
  }
  const reason = reasonInput.trim();
  if (!reason) {
    throw new Error("Changing the minimum group size requires a concrete human reason.");
  }
  process.stdout.write(minimumCohort === 1
    ? [
      "New setting: minimum group size 1 (small-group suppression off).",
      "Consequence: aggregate output may contain a group with one person or record.",
    ].join("\n") + "\n"
    : `New setting: minimum group size ${minimumCohort}. Runner will hide groups with fewer than ${minimumCohort} rows.\n`);
  if (!await input.session.confirm(
    `Save this privacy change for ${input.resourceId}?`,
    { defaultValue: true },
  )) {
    process.stdout.write("Privacy change discarded. Nothing was saved or activated.\n");
    return "back";
  }
  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    {
      resource_id: input.resourceId,
      minimum_cohort_size: minimumCohort,
      actor: localInteractiveActor(),
      reason,
    },
    input.schemaInspector,
  );
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved minimum group size ${minimumCohort}${minimumCohort === 1 ? " (small-group suppression off)" : ""} in disabled boundary revision ${committed.review_revision}.`,
    "Agent authority changed: no.",
    "Ask does not use this minimum group size until the updated boundary is activated.",
    "",
  ].join("\n"));
  return input.focusedAccess
    ? offerImmediateBoundaryActivation(input.session)
    : 0;
}

async function interactiveBoundaryMinimumCohortReview(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess: boolean;
}): Promise<number | "back" | "review"> {
  const resources = (await listBoundaryResourceReviews(input.projectRoot))
    .filter((resource) => resource.included);
  if (!resources.length) {
    process.stdout.write("Add at least one table before setting boundary-wide privacy.\n");
    return "back";
  }
  const currentValues = [...new Set(resources.map((resource) =>
    resource.minimum_cohort_size ?? 5))].sort((left, right) => left - right);
  const currentLabel = currentValues.length === 1
    ? String(currentValues[0])
    : `mixed (${currentValues.join(", ")})`;
  process.stdout.write([
    "",
    `PRIVACY - ALL ${resources.length} TABLES IN THIS BOUNDARY`,
    `Current minimum group size: ${currentLabel}`,
    "Runner hides aggregate groups with fewer rows than the selected number.",
    "Enter a whole number from 1 through 5. Use 1 to turn small-group suppression off for every included table.",
    "",
  ].join("\n"));
  const enteredInput = await input.session.promptText(
    `New minimum group size for all tables [current ${currentLabel}]: `,
  );
  if (enteredInput === undefined) return "back";
  const entered = enteredInput.trim().toLowerCase();
  if (!entered) return "back";
  const minimumCohort = entered === "off" || entered === "none" || entered === "0"
    ? 1
    : Number(entered);
  if (!Number.isSafeInteger(minimumCohort) || minimumCohort < 1 || minimumCohort > 5) {
    throw new Error(
      "Enter a whole number from 1 through 5. Use 1 to turn small-group suppression off.",
    );
  }
  const changed = resources.filter((resource) =>
    (resource.minimum_cohort_size ?? 5) !== minimumCohort);
  if (!changed.length) {
    process.stdout.write(`Every table already uses minimum group size ${minimumCohort}.\n`);
    return "back";
  }
  const reasonInput = await input.session.promptText(
    `Reason for setting ${changed.length} table${changed.length === 1 ? "" : "s"} to minimum group size ${minimumCohort} (recorded with this decision): `,
  );
  if (reasonInput === undefined) {
    process.stdout.write("Returned to boundary review. No minimum group size changed.\n");
    return "back";
  }
  const reason = reasonInput.trim();
  if (!reason) {
    throw new Error("Changing minimum group sizes requires a concrete human reason.");
  }
  process.stdout.write(minimumCohort === 1
    ? [
      "New setting: minimum group size 1 for every included table (small-group suppression off).",
      "Consequence: aggregate output may contain groups with one person or record.",
    ].join("\n") + "\n"
    : `New setting: minimum group size ${minimumCohort} for every included table. Runner will hide groups with fewer than ${minimumCohort} rows.\n`);
  if (!await input.session.confirm(
    `Save this privacy change for ${changed.length} table${changed.length === 1 ? "" : "s"}?`,
    { defaultValue: true },
  )) {
    process.stdout.write("Boundary-wide privacy change discarded. Nothing was saved or activated.\n");
    return "back";
  }
  const actor = localInteractiveActor();
  const preview = await prepareBoundaryReviewMutationBatch(
    input.projectRoot,
    changed.map((resource) => ({
      resource_id: resource.resource_id,
      minimum_cohort_size: minimumCohort,
      actor,
      reason,
    })),
    input.schemaInspector,
  );
  const committed = await commitBoundaryReviewMutationBatch(input.projectRoot, preview);
  process.stdout.write([
    `Saved minimum group size ${minimumCohort}${minimumCohort === 1 ? " (small-group suppression off)" : ""} for ${changed.length} table${changed.length === 1 ? "" : "s"} in disabled boundary revision ${committed.review_revision}.`,
    "Agent authority changed: no.",
    "Ask does not use these minimum group sizes until the updated boundary is activated.",
    "",
  ].join("\n"));
  return input.focusedAccess
    ? offerImmediateBoundaryActivation(input.session)
    : 0;
}

async function offerImmediateBoundaryActivation(
  session: BoundaryReviewInteractiveSession,
): Promise<"back" | "review"> {
  const activate = await session.confirm(
    "Review and activate this boundary change now?",
    { defaultValue: true },
  );
  if (activate) return "review";
  process.stdout.write([
    "1 pending boundary change is not active.",
    "Existing Ask access, if any, continues to use the previous exact boundary revision.",
    "To activate it later: run /access, select this boundary, and press C (Review + activate).",
    "",
  ].join("\n"));
  return "back";
}

function focusedEditNeedsExplicitReason(
  view: BoundaryResourceReviewView,
  changed: Array<{ field: string; tier: BoundaryFieldTier }>,
): boolean {
  return changed.some(({ field, tier }) => {
    const previous = currentBoundaryFieldTier(view, field);
    const candidate = view.candidate ?? view.generated_candidate;
    if (field === candidate?.tenant_key || field === candidate?.principal_key) {
      return previous !== tier;
    }
    const sensitivity = view.fields.find((item) => item.name === field)?.sensitivity?.state;
    if (sensitivity === "structurally_low_risk") return false;
    return (previous === "kept_out" && tier !== "kept_out")
      || (previous === "withheld_from_model" && tier === "visible");
  });
}

function focusedTierOutcome(tier: BoundaryFieldTier): string {
  if (tier === "withheld_from_model") return "Runner only (withheld from model)";
  if (tier === "kept_out") return "Kept out";
  return "Model + Runner";
}

function formatFocusedBoundaryEditSaved(
  resourceId: string,
  action: "added" | "updated" | "removed",
  revision: number,
): string {
  return [
    "",
    `Draft ${action}: ${resourceId}`,
    `Saved in disabled boundary revision ${revision}. Agent authority changed: no.`,
    "Next: review and activate the complete boundary, or go back to keep editing.",
    "",
  ].join("\n");
}

function changedFieldTiers(
  view: BoundaryResourceReviewView,
  selected: Record<string, BoundaryFieldTier>,
): Array<{ field: string; tier: BoundaryFieldTier }> {
  return Object.entries(selected)
    .filter(([field, tier]) => currentBoundaryFieldTier(view, field) !== tier)
    .map(([field, tier]) => ({ field, tier }))
    .sort((left, right) => left.field.localeCompare(right.field));
}

function currentBoundaryFieldTier(
  view: BoundaryResourceReviewView,
  field: string,
): BoundaryFieldTier {
  const candidate = view.candidate ?? view.generated_candidate;
  if (candidate?.kept_out_fields.includes(field)) return "kept_out";
  if (candidate?.model_withheld_fields?.includes(field)) return "withheld_from_model";
  if (candidate?.selectable_fields.includes(field)) return "visible";
  return "kept_out";
}

function boundaryRequestCommandArgs(
  projectRoot: string,
  request: BoundaryResourceReviewRequest,
): string[] {
  const args = [
    request.resource_id,
    "--project-root", projectRoot,
  ];
  if (request.include) args.push("--include");
  if (request.exclude) args.push("--exclude");
  if (request.keep_out_fields?.length) args.push("--keep-out", request.keep_out_fields.join(","));
  if (request.withhold_from_model_fields?.length) {
    args.push("--withhold-from-model", request.withhold_from_model_fields.join(","));
  }
  if (request.allow_reviewed_fields?.length) {
    args.push("--allow-reviewed-field", request.allow_reviewed_fields.join(","));
  }
  args.push("--actor", request.actor, "--reason", request.reason);
  return args;
}

function boundaryResourceApplyCommand(args: string[]): string {
  const retained: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json" || arg === "--apply") continue;
    if (arg === "--confirm") {
      index += 1;
      continue;
    }
    retained.push(arg);
  }
  return [
    cliCommandName(),
    "boundary",
    "review",
    "resource",
    ...retained,
    "--apply",
  ].map(shellCommandToken).join(" ");
}

function shellCommandToken(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : shellQuote(value);
}

function formatBoundaryMutationCommit(
  projectRoot: string,
  revision: number,
  candidateDigest: string,
  actor: string,
): string {
  return [
    `Saved disabled boundary review revision ${revision}.`,
    `Candidate digest: ${candidateDigest}`,
    "Authority activated: no",
    "Source database changed: no",
    `Next: ${cliCommandName()} boundary review --confirm --project-root ${shellCommandToken(projectRoot)} --actor ${shellCommandToken(actor)}`,
    "",
  ].join("\n");
}


async function verifyBoundaryReviewMutationOperator(input: {
  args: string[];
  projectRoot: string;
  preview: Pick<
    BoundaryReviewMutationPreview | BoundaryReviewMutationBatchPreview,
    "decision_digest" | "bindings" | "candidate_digest"
      | "generated_contract_digest" | "candidate"
  >;
  expectedActor: string;
  reason: string;
}): Promise<{
  store: ProposalStore;
  key: string;
  decisionId: `sha256:${string}`;
  subject: string;
  provider: "signed_key" | "jwt_oidc";
}> {
  const resolvedProject = await resolveSynapsorProject(input.projectRoot, process.env);
  const configPath = optionalArg(input.args, "--config") ?? resolvedProject?.config_path;
  if (!configPath) {
    throw new Error("Noninteractive boundary review requires a discoverable Runner config or --config <path>.");
  }
  const config = await readRuntimeConfig(configPath);
  if (config.operator_identity?.provider !== "signed_key"
    && config.operator_identity?.provider !== "jwt_oidc") {
    throw new Error("Noninteractive boundary review requires configured signed_key or jwt_oidc operator identity.");
  }
  const requiredRole = optionalArg(input.args, "--required-role")?.trim();
  if (!requiredRole) {
    throw new Error("Noninteractive boundary review requires --required-role <reviewed-operator-role>.");
  }
  const now = new Date();
  const expiresAt = boundaryDecisionExpiry(optionalArg(input.args, "--expires-at"), now);
  const nonce = optionalArg(input.args, "--nonce")?.trim() || crypto.randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9._~-]{16,200}$/.test(nonce)) {
    throw new Error("Boundary review nonce must contain 16-200 URL-safe non-secret characters.");
  }
  const envelope = {
    schema_version: "synapsor.boundary-review-operator-decision.v1",
    review_decision_digest: input.preview.decision_digest,
    before: input.preview.bindings,
    after_candidate_digest: input.preview.candidate_digest,
    generated_contract_digest: input.preview.generated_contract_digest,
    required_role: requiredRole,
    environment: input.preview.candidate.deployment_profile,
    issued_at: now.toISOString(),
    expires_at: expiresAt,
    nonce,
  };
  const decisionId = canonicalJsonDigest(envelope);
  const identity = await resolveOperatorIdentity({
    config: config.operator_identity as OperatorIdentityConfig,
    configPath,
    proposal: {
      proposal_id: `boundary_review_${input.preview.decision_digest.slice("sha256:".length, "sha256:".length + 24)}`,
      proposal_version: 1,
      proposal_hash: decisionId,
    },
    action: "boundary_review",
    reason: input.reason,
    actor: input.expectedActor,
    identity: optionalArg(input.args, "--identity"),
    privateKeyPath: optionalArg(input.args, "--identity-key"),
    requiredRole,
    now: now.toISOString(),
  });
  if (!identity.verified || identity.provider === "dev_env") {
    throw new Error("Noninteractive boundary-review identity was not cryptographically verified.");
  }
  if (identity.subject !== input.expectedActor) {
    throw new Error("The verified operator subject does not match the reviewer identity bound into this decision.");
  }
  await assertFreshOperatorProof(
    identity,
    config.operator_identity as OperatorIdentityConfig,
    configPath,
  );
  const storePath = resolvedProject?.store_path
    ?? (config.storage?.sqlite_path
      ? path.resolve(config.storage.sqlite_path)
      : path.join(input.projectRoot, ".synapsor/local.db"));
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const store = new ProposalStore(storePath);
  const key = `boundary_review_decision:${decisionId}`;
  if (store.getRunnerState(key)) {
    store.close();
    throw new Error("Boundary-review decision was already consumed; create a fresh short-lived decision with a new nonce.");
  }
  store.setRunnerState(key, {
    status: "consumed_before_review_mutation",
    decision_id: decisionId,
    review_decision_digest: input.preview.decision_digest,
    candidate_digest: input.preview.candidate_digest,
    subject: identity.subject,
    provider: identity.provider,
    decision_hash: identity.decision_hash,
    integrity_hash: identity.integrity_hash,
    issued_at: now.toISOString(),
    expires_at: expiresAt,
    nonce_digest: canonicalJsonDigest({ nonce }),
    source_database_changed: false,
  });
  return {
    store,
    key,
    decisionId,
    subject: identity.subject,
    provider: identity.provider,
  };
}


function boundaryMutationPublicPreview(preview: BoundaryReviewMutationPreview): Record<string, unknown> {
  return {
    ok: true,
    schema_version: preview.schema_version,
    bindings: preview.bindings,
    request: preview.request,
    decision_digest: preview.decision_digest,
    candidate_digest: preview.candidate_digest,
    generated_contract_digest: preview.generated_contract_digest,
    semantic_diff: preview.semantic_diff,
    source_database_changed: false,
    authority_activated: false,
  };
}

function boundaryBatchMutationPublicPreview(
  preview: BoundaryReviewMutationBatchPreview,
): Record<string, unknown> {
  return {
    ok: true,
    schema_version: preview.schema_version,
    bindings: preview.bindings,
    requests: preview.requests,
    decision_digest: preview.decision_digest,
    candidate_digest: preview.candidate_digest,
    generated_contract_digest: preview.generated_contract_digest,
    semantic_diff: preview.semantic_diff,
    source_database_changed: false,
    authority_activated: false,
  };
}


function formatBoundaryMutationPreview(
  preview: BoundaryReviewMutationPreview,
  view: BoundaryResourceReviewView,
  applyCommand?: string,
): string {
  const diff = preview.semantic_diff;
  const requested = formatRequestedBoundaryChanges(preview.request, view);
  const effective = [
    ...(diff.before_included !== diff.after_included
      ? [`  Table access: ${diff.before_included ? "included" : "not included"} -> ${diff.after_included ? "included" : "excluded"}`]
      : []),
    ...(diff.added_model_withheld_fields.length
      ? [`  Model-withheld fields added: ${diff.added_model_withheld_fields.join(", ")}`]
      : []),
    ...(diff.removed_model_withheld_fields.length
      ? [`  Model-withheld fields removed: ${diff.removed_model_withheld_fields.join(", ")}`]
      : []),
    ...(diff.added_kept_out_fields.length
      ? [`  Kept-out fields added: ${diff.added_kept_out_fields.join(", ")}`]
      : []),
    ...(diff.removed_kept_out_fields.length
      ? [`  Kept-out fields removed: ${diff.removed_kept_out_fields.join(", ")}`]
      : []),
    ...(diff.added_visible_fields.length
      ? [`  Visible fields added: ${diff.added_visible_fields.join(", ")}`]
      : []),
    ...(diff.removed_visible_fields.length
      ? [`  Visible fields removed: ${diff.removed_visible_fields.join(", ")}`]
      : []),
    ...(diff.added_relationships.length
      ? [`  Relationships added: ${diff.added_relationships.join(", ")}`]
      : []),
    ...(diff.removed_relationships.length
      ? [`  Relationships removed: ${diff.removed_relationships.join(", ")}`]
      : []),
    ...(diff.minimum_cohort_before !== diff.minimum_cohort_after
      ? [
        `  Minimum group size: ${diff.minimum_cohort_before ?? "not included"} -> ` +
        `${diff.minimum_cohort_after ?? "not included"}` +
        `${diff.minimum_cohort_overridden ? " (explicit owner override)" : ""}`,
      ]
      : []),
    ...(diff.max_ranked_groups_before !== diff.max_ranked_groups_after
      ? [
        `  Ranked underlying groups: ${diff.max_ranked_groups_before ?? "not included"} -> ` +
        `${diff.max_ranked_groups_after ?? "not included"}`,
      ]
      : []),
  ];
  return [
    "Preview of one pending review decision. Nothing is saved or active yet.",
    "",
    `Table: ${diff.resource_id}`,
    requested.length === 1 ? "Requested change:" : "Requested changes:",
    ...requested.map((line) => `  ${line}`),
    "",
    "Validated effect:",
    ...(effective.length ? effective : ["  Reviewed metadata changes only; runtime authority is unchanged."]),
    "  Everything else: unchanged.",
    ...(diff.minimum_cohort_after === 1
      ? ["  Warning: 1 disables small-group suppression; groups of one identify individuals."]
      : []),
    "",
    "The saved decision will be digest-bound; use --json to inspect the exact digests.",
    "Authority activated: no. Source database changed: no.",
    "",
    ...(applyCommand
      ? [`Next: ${applyCommand}`]
      : ["Press Enter at the next prompt to save this disabled decision; type n to discard it."]),
    "",
  ].join("\n");
}

function formatRequestedBoundaryChanges(
  request: BoundaryResourceReviewRequest,
  view: BoundaryResourceReviewView,
): string[] {
  const lines: string[] = [];
  for (const field of request.withhold_from_model_fields ?? []) {
    lines.push(`Withhold from model: ${describeReviewedField(view, field)}`);
  }
  for (const field of request.keep_out_fields ?? []) {
    lines.push(`Keep out: ${describeReviewedField(view, field)}`);
  }
  for (const field of request.allow_reviewed_fields ?? []) {
    lines.push(`Allow reviewed model-visible use: ${describeReviewedField(view, field)}`);
  }
  if (request.include) lines.push(`Include ${request.resource_id} in the disabled candidate.`);
  if (request.exclude) lines.push(`Exclude ${request.resource_id} from the disabled candidate.`);
  if (request.row_identity) lines.push(`Record ID: ${describeReviewedField(view, request.row_identity)}`);
  if (request.tenant_key) lines.push(`Trusted customer scope: ${describeReviewedField(view, request.tenant_key)}`);
  if (request.tenant_scope_path) {
    const scope = view.derived_tenant_scope?.candidates.find((candidate) =>
      candidate.path_id === request.tenant_scope_path);
    lines.push(`Trusted customer scope: mandatory reviewed path ${scope
      ? formatDerivedScopePath(scope)
      : request.tenant_scope_path}`);
  }
  if (request.shared_reference_scope) {
    lines.push(
      "Row scope: Shared reference; no tenant predicate will be applied to this table, while field, cohort, and budget controls remain enforced.",
    );
  }
  if (request.principal_key !== undefined) {
    lines.push(request.principal_key === null
      ? "Trusted user/owner scope: not configured."
      : `Trusted user/owner scope: ${describeReviewedField(view, request.principal_key)}`);
  }
  for (const [label, fields] of [
    ["Visible fields", request.selectable_fields],
    ["Filterable fields", request.filterable_fields],
    ["Sortable fields", request.sortable_fields],
    ["Groupable fields", request.groupable_fields],
    ["Aggregate measures", request.aggregate_measures],
    ["Count-distinct fields", request.count_distinct_fields],
    ["Time-bucket fields", request.time_bucket_fields],
  ] as const) {
    if (fields) lines.push(`${label}: ${fields.join(", ") || "none"}.`);
  }
  if (request.minimum_cohort_size !== undefined) {
    lines.push(`Minimum returned cohort: ${request.minimum_cohort_size}.`);
  }
  if (request.max_ranked_groups !== undefined) {
    lines.push(
      `Maximum underlying groups for bounded top/bottom and period-mover queries: ` +
      `${request.max_ranked_groups}.`,
    );
  }
  if (request.relationship_ids) {
    lines.push(`Reviewed relationships: ${request.relationship_ids.join(", ") || "none"}.`);
  }
  if (request.nullable_relationship) {
    lines.push(
      `Nullable relationship ${request.nullable_relationship.relationship_id}: ` +
      `${request.nullable_relationship.unmatched_rows === "keep_null" ? "retain unmatched rows" : "exclude unmatched rows"}.`,
    );
  }
  return lines.length ? lines : ["No effective review change was requested."];
}

function describeReviewedField(view: BoundaryResourceReviewView, fieldName: string): string {
  const field = view.fields.find((candidate) => candidate.name === fieldName);
  if (!field) return `${fieldName} column of ${view.resource_id}`;
  const enumEvidence = field.evidence.find((item) => item.startsWith("database enum values:"));
  const knownValues = enumEvidence?.slice("database enum values:".length).trim();
  return `${field.name} - ${field.data_type} column of ${view.resource_id}` +
    `${knownValues ? ` (database-declared values: ${knownValues})` : ""}`;
}

function formatBoundaryBatchMutationPreview(
  preview: BoundaryReviewMutationBatchPreview,
  expectedConfirmation: string,
): string {
  return [
    "Disabled boundary-review batch preview",
    `  resource decisions: ${preview.requests.length}`,
    `  changed authority: ${preview.semantic_diff.filter((item) => item.authority_changed).length}`,
    ...preview.semantic_diff.map((item) =>
      `  - ${item.resource_id}: ${item.before_included ? "included" : "blocked"} -> ${item.after_included ? "included" : "excluded"}`),
    `  candidate digest: ${preview.candidate_digest}`,
    `  decision digest: ${preview.decision_digest}`,
    "  authority activated: no",
    "  source database changed: no",
    `Next: rerun with --apply and confirm ${shellQuote(expectedConfirmation)} in a real operator terminal.`,
    "",
  ].join("\n");
}


export async function boundaryActivateCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
  interactiveSession?: BoundaryReviewInteractiveSession,
  activationHandoff?: BoundaryActivationHandoff,
): Promise<number> {
  if (args.includes("--yes")) {
    throw new Error("boundary activate does not accept --yes; activation requires exact digest confirmation and a human or cryptographically verified operator decision.");
  }
  assertKnownOptions(
    args,
    new Set([
      "--project-root",
      "--config",
      "--review-bundle",
      "--headless",
      "--confirm",
      "--actor",
      "--identity",
      "--identity-key",
      "--required-role",
      "--reason",
      "--environment",
      "--expires-at",
      "--nonce",
      "--json",
    ]),
    "boundary activate",
  );
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const context = await loadBoundaryReviewContext(projectRoot);
  if (context.progress?.policy_migration.status === "review_required") {
    throw new Error([
      `Boundary ${context.candidate.pack.name} has legacy project-wide review settings that are not yet isolated to its immutable boundary identity.`,
      "Runner preserved the exact saved boundary revision but will not activate it as newly reviewed policy.",
      "Open /access and save a reviewed setting for this boundary, or Rescan, then review and activate the resulting disabled revision.",
    ].join("\n"));
  }
  const headless = args.includes("--headless");
  const expectedConfirmation = `ACTIVATE ${context.bundle.candidate_digest}`;
  let confirmation = optionalArg(args, "--confirm")?.trim();
  let actor = optionalArg(args, "--actor")?.trim();
  let operator: {
    subject: string;
    provider: "interactive_terminal" | "signed_key" | "jwt_oidc";
    verified: boolean;
    decision_hash?: string;
    integrity_hash?: string;
    key_id?: string;
    roles?: string[];
    decision_id?: `sha256:${string}`;
  };
  let consumedDecision: {
    store: ProposalStore;
    key: string;
    decisionId: `sha256:${string}`;
    expiresAt: string;
  } | undefined;

  if (headless) {
    if (process.stdin.isTTY && !confirmation) {
      throw new Error(`Headless activation still requires --confirm ${shellQuote(expectedConfirmation)}.`);
    }
    if (confirmation !== expectedConfirmation) {
      throw new Error(`Headless activation requires the exact confirmation ${expectedConfirmation}.`);
    }
    const bundlePath = optionalArg(args, "--review-bundle");
    if (!bundlePath) throw new Error("Headless activation requires --review-bundle <exported-review.json>.");
    const suppliedBundle = await readJsonFileWithLocation<BoundaryReviewBundle>(bundlePath, "boundary review bundle");
    assertCurrentBoundaryReviewBundle(suppliedBundle, context.bundle);

    const resolvedProject = await resolveSynapsorProject(projectRoot, process.env);
    const configPath = optionalArg(args, "--config") ?? resolvedProject?.config_path;
    if (!configPath) {
      throw new Error("Headless activation requires a discoverable Runner config or --config <path> with signed_key or jwt_oidc operator identity.");
    }
    const config = await readRuntimeConfig(configPath);
    if (config.operator_identity?.provider !== "signed_key" && config.operator_identity?.provider !== "jwt_oidc") {
      throw new Error("Headless activation requires a configured signed_key or jwt_oidc operator identity.");
    }
    const requiredRole = optionalArg(args, "--required-role")?.trim();
    if (!requiredRole) throw new Error("Headless activation requires --required-role <reviewed-operator-role>.");
    const reason = optionalArg(args, "--reason")?.trim();
    if (!reason) throw new Error("Headless activation requires --reason <human review reason>.");
    const environment = optionalArg(args, "--environment")?.trim() ?? context.candidate.deployment_profile;
    if (environment !== context.candidate.deployment_profile) {
      throw new Error(`Activation environment ${environment} does not match reviewed deployment profile ${context.candidate.deployment_profile}.`);
    }
    const now = new Date();
    const expiresAt = boundaryDecisionExpiry(optionalArg(args, "--expires-at"), now);
    const nonce = optionalArg(args, "--nonce")?.trim() || crypto.randomBytes(24).toString("base64url");
    if (!/^[A-Za-z0-9._~-]{16,200}$/.test(nonce)) {
      throw new Error("Boundary activation nonce must contain 16-200 URL-safe non-secret characters.");
    }
    const decisionEnvelope = {
      schema_version: "synapsor.boundary-activation-decision.v1",
      review_bundle_digest: context.bundle.bundle_digest,
      boundary_digest: context.bundle.candidate_digest,
      confirmed_decision_ids: context.bundle.decisions.map((decision) => decision.id).sort(),
      schema_fingerprint: context.bundle.authority.schema_fingerprint,
      generation_lock_fingerprint: context.bundle.authority.generation_lock_fingerprint,
      role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint,
      compiler_version: context.bundle.authority.compiler_version,
      spec_version: context.bundle.authority.spec_version,
      deployment_profile: context.bundle.authority.deployment_profile,
      environment,
      budgets: context.bundle.authority.budgets,
      required_role: requiredRole,
      issued_at: now.toISOString(),
      expires_at: expiresAt,
      nonce,
    };
    const decisionId = canonicalJsonDigest(decisionEnvelope);
    const identity = await resolveOperatorIdentity({
      config: config.operator_identity as OperatorIdentityConfig,
      configPath,
      proposal: {
        proposal_id: `boundary_${context.bundle.candidate_digest.slice("sha256:".length, "sha256:".length + 24)}`,
        proposal_version: 1,
        proposal_hash: decisionId,
      },
      action: "boundary_activate",
      reason,
      actor,
      identity: optionalArg(args, "--identity"),
      privateKeyPath: optionalArg(args, "--identity-key"),
      requiredRole,
      now: now.toISOString(),
    });
    if (!identity.verified || identity.provider === "dev_env") {
      throw new Error("Headless boundary activation identity was not cryptographically verified.");
    }
    await assertFreshOperatorProof(identity, config.operator_identity as OperatorIdentityConfig, configPath);
    actor = identity.subject;
    operator = {
      subject: identity.subject,
      provider: identity.provider,
      verified: true,
      decision_hash: identity.decision_hash,
      integrity_hash: identity.integrity_hash,
      key_id: identity.key_id,
      roles: identity.roles,
      decision_id: decisionId,
    };

    const storePath = resolvedProject?.store_path
      ?? (config.storage?.sqlite_path ? path.resolve(config.storage.sqlite_path) : path.join(projectRoot, ".synapsor/local.db"));
    await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const store = new ProposalStore(storePath);
    const key = `boundary_activation_decision:${decisionId}`;
    if (store.getRunnerState(key)) {
      store.close();
      throw new Error("Boundary activation decision was already consumed; create a fresh short-lived decision with a new nonce.");
    }
    store.setRunnerState(key, {
      status: "consumed_before_activation",
      decision_id: decisionId,
      boundary_digest: context.bundle.candidate_digest,
      subject: identity.subject,
      provider: identity.provider,
      decision_hash: identity.decision_hash,
      integrity_hash: identity.integrity_hash,
      issued_at: now.toISOString(),
      expires_at: expiresAt,
      nonce_digest: canonicalJsonDigest({ nonce }),
      source_database_changed: false,
    });
    consumedDecision = { store, key, decisionId, expiresAt };

    const progress = createBoundaryReviewProgress({
      draft: context.draft,
      candidate: context.candidate,
      confirmedDecisions: context.draft.unresolved_decisions,
      previous: context.progress,
      actor: identity.subject,
      revision: (context.progress?.revision ?? 0) + 1,
      now: now.toISOString(),
    });
    try {
      await saveBoundaryReviewProgress(projectRoot, progress);
    } catch (error) {
      store.setRunnerState(key, {
        status: "consumed_review_persistence_failed",
        decision_id: decisionId,
        boundary_digest: context.bundle.candidate_digest,
        subject: identity.subject,
        provider: identity.provider,
        failed_at: new Date().toISOString(),
        source_database_changed: false,
      });
      store.close();
      consumedDecision = undefined;
      throw error;
    }
  } else {
    if (!interactiveSession && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error("Noninteractive boundary activation requires --headless and a verified signed_key or jwt_oidc operator identity.");
    }
    if (context.bundle.outstanding_decision_ids.length > 0) {
      throw new Error(
        `Boundary activation is blocked by ${context.bundle.outstanding_decision_ids.length} unresolved decision(s). Run boundary review --confirm first.`,
      );
    }
    const session = interactiveSession ?? createBoundaryReviewInteractiveSession();
    process.stdout.write([
      formatBoundaryReviewSummary(context.bundle, { nextAction: false }).trimEnd(),
      `Exact reviewed fingerprint: ${context.bundle.candidate_digest}`,
      context.candidate.deployment_profile === "production"
        ? "Activation makes this boundary eligible only for an explicitly configured secured production HTTP Explore runtime."
        : "Activation adds this reviewed boundary to local read-only Explore. Each query remains inside exactly one active boundary.",
      "",
    ].join("\n"));
    if (!confirmation) {
      const approved = await session.confirm(
        `Activate "${context.candidate.pack.name}" now?`,
        { defaultValue: true },
      );
      if (!approved) {
        process.stdout.write([
          "Boundary remains reviewed and inactive.",
          "No agent authority or source data changed.",
          `Resume: ${cliCommandName()} boundary activate`,
          "",
        ].join("\n"));
        return 0;
      }
      confirmation = expectedConfirmation;
    }
    if (!actor) {
      actor = await session.promptText("Human operator identity (audit label, not a password): ");
    }
    if (confirmation !== expectedConfirmation) throw new Error(`Activation requires the exact confirmation ${expectedConfirmation}.`);
    if (!actor) {
      process.stdout.write([
        "Returned to boundary review. The reviewed boundary remains inactive.",
        "No agent authority or source data changed.",
        "",
      ].join("\n"));
      return 0;
    }
    operator = { subject: actor, provider: "interactive_terminal", verified: false };
  }

  let activatedBoundary: Awaited<ReturnType<typeof activateExplorationBoundary>> | undefined;
  try {
    const inspection = await schemaInspector({
      engine: context.lock.engine,
      databaseUrlEnv: context.lock.source_env,
      schema: context.lock.inspected_schema,
      env: process.env,
    });
    const active = await activateExplorationBoundary({
      projectRoot,
      candidate: context.candidate,
      expectedDigest: context.bundle.candidate_digest,
      actor: actor!,
      confirmation: expectedConfirmation,
      confirmedDecisions: context.draft.unresolved_decisions,
      currentInspection: inspection,
      activeSetMode: "add",
    });
    await updateGuidedOnboardingState({
      projectRoot,
      status: "boundary_active",
      completedStep: "boundary_active",
      authorityActive: true,
      recommendedNextAction: active.deployment_profile === "production"
        ? "Configure the secured production HTTP runtime, initialize shared accounting, and run doctor before serving."
        : "Choose a model or MCP client and ask your first reviewed question.",
      now: active.activation.activated_at,
    }).catch(() => undefined);
    if (consumedDecision) {
      consumedDecision.store.setRunnerState(consumedDecision.key, {
        status: "activated",
        decision_id: consumedDecision.decisionId,
        boundary_digest: active.activation.digest,
        subject: operator.subject,
        provider: operator.provider,
        decision_hash: operator.decision_hash ?? "interactive",
        integrity_hash: operator.integrity_hash ?? "interactive",
        activated_at: active.activation.activated_at,
        expires_at: consumedDecision.expiresAt,
        source_database_changed: false,
      });
      consumedDecision.store.recordAttentionEvent({
        event_type: "capability.activated",
        severity: "informational",
        environment: active.deployment_profile,
        capability: "app.explore_data",
        contract_digest: active.activation.digest,
        attention_required: false,
        immediate_default: false,
        summary: active.deployment_profile === "production"
          ? "Verified operator activated reviewed production HTTP Explore authority"
          : "Verified operator activated reviewed local authoring authority",
        workbench_path: "/",
        details: {
          authority_type: "scoped_explore",
          operator_provider: operator.provider,
          operator_subject_digest: canonicalJsonDigest({ subject: operator.subject }),
          decision_id: consumedDecision.decisionId,
          source_database_changed: false,
        },
        source_event_key: `boundary-cli-activated:${consumedDecision.decisionId}`,
        now: active.activation.activated_at,
      });
    }
    const payload = {
      ok: true,
      active,
      operator,
      source_database_changed: false,
      model_facing_activation_tool: false,
    };
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : [
        active.deployment_profile === "production"
          ? `Reviewed boundary "${active.pack.name}" is active for secured production HTTP Explore.`
          : `Reviewed boundary "${active.pack.name}" is active for local read-only Explore.`,
        `Exact fingerprint: ${active.activation.digest}`,
        "Source database changed: no",
        "",
      ].join("\n"));
    activatedBoundary = active;
  } catch (error) {
    if (consumedDecision) {
      consumedDecision.store.setRunnerState(consumedDecision.key, {
        status: "consumed_activation_failed",
        decision_id: consumedDecision.decisionId,
        boundary_digest: context.bundle.candidate_digest,
        subject: operator.subject,
        provider: operator.provider,
        failed_at: new Date().toISOString(),
        safe_error: redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
        source_database_changed: false,
      });
    }
    throw error;
  } finally {
    consumedDecision?.store.close();
  }
  if (!headless
    && !args.includes("--json")
    && activationHandoff
    && activatedBoundary
    && activatedBoundary.deployment_profile !== "production") {
    return activationHandoff({
      projectRoot,
      boundaryName: activatedBoundary.pack.name,
      boundaryDigest: activatedBoundary.activation.digest,
    });
  }
  if (!headless && !args.includes("--json") && activatedBoundary) {
    process.stdout.write(activatedBoundary.deployment_profile === "production"
      ? [
        "Next: configure the secured production HTTP runtime, initialize its shared accounting ledger, and run doctor.",
        "Guide: docs/production-scoped-explore-http.md",
        "",
      ].join("\n")
      : `Next: ${cliCommandName()} try ask --provider openai --model gpt-5-mini\n`);
  }
  return 0;
}


export async function loadBoundaryReviewContext(projectRoot: string): Promise<{
  boundaryRoot: string;
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  lock: GenerationLock;
  progress: Awaited<ReturnType<typeof readBoundaryReviewProgress>>;
  bundle: BoundaryReviewBundle;
}> {
  const journey = await readGuidedOnboardingState(projectRoot);
  const boundaryRoot = path.resolve(projectRoot, journey?.artifacts.boundary_root ?? "synapsor/generated");
  const relative = path.relative(projectRoot, boundaryRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed boundary root escapes the selected project.");
  }
  const draft = await readJsonFileWithLocation<ExplorationBoundaryDraft>(
    path.join(boundaryRoot, "exploration-boundary.draft.json"),
    "exploration boundary draft",
  );
  const lock = await readJsonFileWithLocation<GenerationLock>(
    path.join(projectRoot, ".synapsor/generation-lock.json"),
    "generation lock",
  );
  const progress = await readBoundaryReviewProgress(projectRoot, draft);
  const candidate = progress?.candidate ?? recommendedBoundaryReviewCandidate(draft);
  const decisions = boundaryReviewDecisions(candidate).map((decision) => ({
    ...decision,
    confirmed: progress?.confirmed_decisions.includes(decision.decision) ?? false,
  }));
  const candidateDigest = explorationBoundaryCandidateDigest(candidate);
  const core = {
    schema_version: "synapsor.boundary-review-bundle.v1" as const,
    candidate_digest: candidateDigest,
    activation: "disabled_unreviewed" as const,
    authority: {
      source: candidate.source,
      deployment_profile: candidate.deployment_profile,
      compiler_version: candidate.compiler_version,
      spec_version: candidate.spec_version,
      generation_lock_fingerprint: candidate.generation_lock_fingerprint,
      schema_fingerprint: lock.schema_fingerprint,
      role_posture_fingerprint: candidate.role_posture_fingerprint,
      environment: candidate.deployment_profile,
      budgets: candidate.budgets,
    },
    decisions,
    outstanding_decision_ids: decisions.filter((decision) => !decision.confirmed).map((decision) => decision.id),
    candidate,
  };
  const bundle: BoundaryReviewBundle = {
    ...core,
    mutation_bindings: {
      draft_digest: explorationBoundaryCandidateDigest(draft),
      candidate_digest: candidateDigest,
      generation_lock_fingerprint: draft.generation_lock_fingerprint,
      schema_fingerprint: lock.schema_fingerprint,
      role_posture_fingerprint: lock.role_posture_fingerprint,
      review_revision: progress?.revision ?? 0,
    },
    bundle_digest: canonicalJsonDigest(core),
  };
  return { boundaryRoot, draft, candidate, lock, progress, bundle };
}


function formatBoundaryReviewSummary(
  bundle: BoundaryReviewBundle,
  options: { nextAction?: boolean } = {},
): string {
  const overview = boundaryReviewOverview(bundle);
  const complete = overview.outstanding_decisions === 0;
  const includeNextAction = options.nextAction !== false;
  return [
    "BOUNDARY REVIEW",
    "",
    ...formatTextTable(
      ["NAME", "STATUS", "TABLES", "REVIEW"],
      [[
        bundle.candidate.pack.name,
        complete ? "REVIEWED - NOT ACTIVE" : "DRAFT - NO ACCESS",
        String(bundle.candidate.pack.resources.length),
        complete ? "Complete" : formatReviewLeft(overview),
      ]],
      [20, 21, 6, 28],
    ),
    "",
    `${overview.confirmed_decisions}/${bundle.decisions.length} exact digest-bound decisions are recorded.`,
    "Authority active: no",
    "Source database changed: no",
    ...(includeNextAction && complete
      ? [
        `Next: ${cliCommandName()} boundary activate`,
        `Advanced fingerprint and decision IDs: ${cliCommandName()} boundary review --json`,
      ]
      : includeNextAction
        ? [
          `Next: ${cliCommandName()} boundary review`,
          "Open a table and sign it off, or choose Review all for the guided remaining review.",
        ]
        : []),
    "",
  ].join("\n");
}

function boundaryReviewOverview(bundle: BoundaryReviewBundle): BoundaryReviewOverview {
  const outstanding = bundle.decisions.filter((decision) => !decision.confirmed);
  const resourceDecisions = outstanding.filter((decision) => Boolean(decision.resource_id));
  return {
    confirmed_decisions: bundle.decisions.length - outstanding.length,
    outstanding_decisions: outstanding.length,
    outstanding_resource_decisions: resourceDecisions.length,
    outstanding_boundary_decisions: outstanding.length - resourceDecisions.length,
    resources_requiring_signoff: new Set(
      resourceDecisions.map((decision) => decision.resource_id),
    ).size,
  };
}

function formatReviewLeft(overview: BoundaryReviewOverview): string {
  const parts: string[] = [];
  if (overview.resources_requiring_signoff) {
    parts.push(
      `${overview.resources_requiring_signoff} ` +
      `${overview.resources_requiring_signoff === 1 ? "table" : "tables"}`,
    );
  }
  if (overview.outstanding_boundary_decisions) parts.push("boundary settings");
  return parts.length ? parts.join(" + ") : "Complete";
}

function formatBoundaryFinalReview(bundle: BoundaryReviewBundle): string {
  const outstanding = bundle.decisions.filter((decision) => !decision.confirmed);
  const rows: string[][] = [];
  if (outstanding.some((decision) => !decision.resource_id)) {
    rows.push([
      "Boundary settings",
      "-",
      bundle.authority.deployment_profile === "production"
        ? "production HTTP + JWT scope"
        : `${bundle.authority.deployment_profile} local authoring`,
      "-",
      "Sign-off needed",
    ]);
  }
  for (const resource of bundle.candidate.pack.resources) {
    if (!outstanding.some((decision) => decision.resource_id === resource.id)) continue;
    rows.push([
      resource.id,
      [
        resource.selectable_fields.filter(
          (field) => !(resource.model_withheld_fields ?? []).includes(field),
        ).length,
        resource.model_withheld_fields?.length ?? 0,
        resource.kept_out_fields.length,
      ].join("/"),
      resource.principal_key
        ? `${reviewedTenantScopeLabel(resource)} + ${resource.principal_key}`
        : resource.principal_scope
          ? `${reviewedTenantScopeLabel(resource)} + derived principal`
          : reviewedTenantScopeLabel(resource),
      `${resource.minimum_cohort_size}/${resource.relationships.length}`,
      "Sign-off needed",
    ]);
  }
  return [
    "FINAL REVIEW",
    "",
    "This records human review of the disabled draft. It does not activate agent access.",
    "Each row below is one plain-language sign-off; exact individual decisions remain digest-bound.",
    "",
    ...formatTextTable(
      ["REVIEW UNIT", "FIELDS M/R/OUT", "ROW SCOPE", "MIN GROUP / LINKS", "STATUS"],
      rows,
      [20, 14, 22, 17, 15],
    ),
    "",
    "M/R/OUT = model-visible / Runner-output-only / kept-out fields.",
    "MIN GROUP / LINKS = minimum returned cohort size / reviewed paths to related tables.",
    "",
  ].join("\n");
}

function reviewedTenantScopeLabel(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): string {
  if (resource.tenant_key) return resource.tenant_key;
  if (resource.tenant_scope) return `through ${formatDerivedScopePath(resource.tenant_scope)}`;
  return "Shared reference (no tenant predicate)";
}

function formatBoundarySettingsSignoff(bundle: BoundaryReviewBundle): string {
  return [
    "BOUNDARY SETTINGS",
    "",
    ...formatTextTable(
      ["SETTING", "REVIEWED VALUE"],
      [
        [
          "Where this can run",
          bundle.authority.deployment_profile === "production"
            ? "production over secured Streamable HTTP; explicit runtime opt-in and verified JWT scope required"
            : `${bundle.authority.deployment_profile} local authoring; production and remote Explore are refused`,
        ],
        [
          "Customer/user scope",
          "Runner supplies trusted values outside AI requests; the AI cannot choose either",
        ],
        [
          "Agent authority",
          "Still disabled after this sign-off; activation remains a separate exact-fingerprint action",
        ],
        [
          "Ranked queries",
          `Validate at most ${bundle.candidate.budgets.max_ranked_groups
            ?? bundle.candidate.budgets.max_groups} candidate groups, suppress small cohorts, ` +
          `then return at most top ${bundle.candidate.budgets.max_top_n}`,
        ],
      ],
      [20, 56],
    ),
    "",
  ].join("\n");
}

function formatBoundaryResourceSignoff(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  decisionCount: number,
): string {
  const modelFields = resource.selectable_fields.filter(
    (field) => !(resource.model_withheld_fields ?? []).includes(field),
  );
  const localFields = resource.model_withheld_fields ?? [];
  const operationCounts = [
    `return ${resource.selectable_fields.length}`,
    `filter ${Object.keys(resource.filterable_fields).length}`,
    `sort ${resource.sortable_fields.length}`,
    `group ${resource.groupable_fields.length}`,
    `measure ${resource.aggregate_measures.length}`,
    `unique ${resource.count_distinct_fields.length}`,
    `time ${Object.keys(resource.time_bucket_fields).length}`,
  ].join(", ");
  return [
    `TABLE SIGN-OFF - ${resource.id}`,
    "",
    ...formatTextTable(
      ["ACCESS", "FIELDS"],
      [
        ["Model + Runner", fieldList(modelFields)],
        ["Raw values: Runner only", fieldList(localFields)],
        ["Kept out", fieldList(resource.kept_out_fields)],
      ],
      [20, 56],
    ),
    "",
    ...formatTextTable(
      ["SETTING", "REVIEWED VALUE"],
      [
        ["Record identity", resource.primary_key],
        ["Customer scope", `${reviewedTenantScopeLabel(resource)} - supplied outside AI requests`],
        [
          "User/owner scope",
          resource.principal_key
            ? `${resource.principal_key} - supplied outside AI requests`
            : resource.principal_scope
              ? `through ${formatDerivedScopePath(resource.principal_scope)} - supplied outside AI requests`
              : "No separate per-user column is configured",
        ],
        ["Allowed operations", operationCounts],
        [
          "Privacy",
          `minimum returned group ${resource.minimum_cohort_size}; suppression-aware totals stay on`,
        ],
        [
          "Related tables",
          resource.relationships.length
            ? resource.relationships.map((relationship) =>
              `${relationship.target_resource} ` +
              `(${relationship.cardinality.replaceAll("_", "-")}, max fan-out ${relationship.max_fan_out})`)
              .join(", ")
            : "None",
        ],
      ],
      [20, 56],
    ),
    "",
    `One confirmation records ${decisionCount} exact digest-bound ` +
      `${decisionCount === 1 ? "decision" : "decisions"} covering this table.`,
    "",
  ].join("\n");
}

function fieldList(fields: string[]): string {
  return fields.length ? fields.join(", ") : "None";
}

function formatTextTable(
  headers: string[],
  rows: string[][],
  maximumWidths: number[],
): string[] {
  const widths = headers.map((header, index) => Math.min(
    maximumWidths[index] ?? 40,
    Math.max(
      header.length,
      ...rows.map((row) => safeCliCell(row[index] ?? "").length),
    ),
  ));
  const formatLine = (row: string[]) => row.map((value, index) => {
    const fitted = safeCliCell(value);
    return index === row.length - 1 ? fitted : fitted.padEnd(widths[index]!);
  }).join("  ");
  const formatRow = (row: string[]): string[] => {
    const cells = row.map((value, index) => wrapCliCell(value, widths[index]!));
    const lines = Math.max(...cells.map((cell) => cell.length));
    return Array.from({ length: lines }, (_, line) =>
      formatLine(cells.map((cell) => cell[line] ?? "")));
  };
  return [
    formatLine(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.flatMap(formatRow),
  ];
}

function wrapCliCell(value: string, width: number): string[] {
  let remaining = safeCliCell(value).trim();
  if (!remaining) return [""];
  const lines: string[] = [];
  while (remaining.length > width) {
    const space = remaining.lastIndexOf(" ", width);
    const comma = remaining.lastIndexOf(", ", width);
    const breakAt = Math.max(space, comma >= 0 ? comma + 1 : -1);
    const length = breakAt > 0 ? breakAt : width;
    lines.push(remaining.slice(0, length).trim());
    remaining = remaining.slice(length).trim();
  }
  lines.push(remaining);
  return lines;
}

function safeCliCell(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}


function assertCurrentBoundaryReviewBundle(
  supplied: BoundaryReviewBundle,
  current: BoundaryReviewBundle,
): void {
  if (supplied.schema_version !== "synapsor.boundary-review-bundle.v1") {
    throw new Error("Unsupported boundary review bundle version.");
  }
  const {
    bundle_digest: suppliedDigest,
    mutation_bindings: _suppliedMutationBindings,
    ...suppliedCore
  } = supplied;
  if (canonicalJsonDigest(suppliedCore) !== suppliedDigest) {
    throw new Error("Boundary review bundle digest does not match its contents.");
  }
  if (suppliedDigest !== current.bundle_digest
    || supplied.candidate_digest !== current.candidate_digest) {
    throw new Error("Boundary review bundle is stale or belongs to a different candidate; export the current review again.");
  }
}


function boundaryDecisionExpiry(value: string | undefined, now: Date): string {
  const maximumMs = 15 * 60 * 1000;
  const expires = value ? new Date(value) : new Date(now.getTime() + 5 * 60 * 1000);
  if (!Number.isFinite(expires.getTime())
    || expires.getTime() <= now.getTime()
    || expires.getTime() - now.getTime() > maximumMs) {
    throw new Error("Boundary activation decision expiry must be in the future and no more than 15 minutes from now.");
  }
  return expires.toISOString();
}


async function assertFreshOperatorProof(
  proof: Awaited<ReturnType<typeof resolveOperatorIdentity>>,
  config: OperatorIdentityConfig,
  configPath: string,
): Promise<void> {
  if (proof.provider === "signed_key") {
    const operator = config.operators?.[proof.subject];
    if (!operator) throw new Error("Verified operator is no longer configured.");
    const publicKey = await fs.readFile(
      path.resolve(path.dirname(path.resolve(configPath)), operator.public_key_path),
      "utf8",
    );
    if (!verifySignedOperatorProof(proof, publicKey)) {
      throw new Error("Signed boundary activation proof failed independent verification.");
    }
    return;
  }
  if (proof.provider === "jwt_oidc") {
    const secretEnv = config.attestation_secret_env ?? "SYNAPSOR_OPERATOR_ATTESTATION_SECRET";
    const secret = process.env[secretEnv]?.trim();
    if (!secret || !verifyJwtOperatorProof(proof, secret)) {
      throw new Error("OIDC boundary activation proof failed independent attestation verification.");
    }
    return;
  }
  throw new Error("Boundary activation proof must use signed_key or jwt_oidc.");
}


export async function startSafeAction(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--action", "--description", "--based-on", "--config", "--project-root", "--force", "--json"]), "start --action");
  const actionName = optionalArg(args, "--action");
  const description = optionalArg(args, "--description");
  if (!actionName) throw new Error("start --action requires a business action name, for example --action refund_order");
  if (!description) throw new Error("start --action requires --description so the intended business effect is reviewable");
  const projectRoot = optionalArg(args, "--project-root") ?? process.cwd();
  const result = await scaffoldSafeAction({
    projectRoot,
    configPath: optionalArg(args, "--config"),
    actionName,
    description,
    basedOnCapability: optionalArg(args, "--based-on"),
    force: args.includes("--force"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: true, state: "disabled_scaffold", ...result }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write([
    "Synapsor Safe Action Composer",
    "",
    `Action: ${result.action_name}`,
    `Draft source: ${result.source_path}`,
    `Inherited read boundary: ${result.based_on_capability}`,
    `Base contract: ${result.base_contract_path}`,
    `Agent instructions: ${result.instructions.canonical}`,
    `Detected project evidence: ${result.project_context.schema_inputs.map((item) => `${item.kind}:${item.path}`).join(", ") || "none"}`,
    `Detected database environment names: ${result.project_context.database_env_names.join(", ") || "none"} (values were not read)`,
    "State: disabled scaffold (active Runner tools are unchanged)",
    "",
    "Authority questions the coding agent must leave for explicit review:",
    ...result.authority_questions.map((item) => `  - ${item.field}: ${item.question}\n    Source: ${item.source}`),
    "",
    "Give your coding agent this task:",
    `  Complete ${result.source_path} using the existing application and schema. Keep trusted tenant/principal values out of model arguments. Resolve every __REVIEW_*__ placeholder, add deterministic allow/deny/effect coverage, and run:`,
    `  ${cliCommandName()} action validate ${result.source_path}`,
    "  Leave the result disabled. Do not edit active contract artifacts or claim activation.",
    "",
    "After validation, open the secured local Workbench for human effect review and activation.",
    "",
  ].join("\n"));
  return 0;
}


export async function actionCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate" || subcommand === "compile") return validateSafeActionCommand(rest);
  if (subcommand === "watch") return watchSafeActionCommand(rest);
  if (subcommand === "status") return safeActionStatusCommand(rest);
  usage(["action"]);
  return 2;
}


async function validateSafeActionCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--project-root", "--json"]), "action validate");
  const sourcePath = positional(args, 0);
  if (!sourcePath) throw new Error("action validate requires a TypeScript Safe Action source path");
  try {
    const result = await compileSafeActionDraft({
      projectRoot: optionalArg(args, "--project-root"),
      configPath: optionalArg(args, "--config"),
      sourcePath,
    });
    const payload = {
      ok: result.manifest.validation.ok,
      state: result.manifest.state,
      action_name: result.manifest.action_name,
      draft_digest: result.manifest.draft_contract_digest,
      draft_contract: result.manifest.draft_contract_path,
      generated_tests: result.manifest.generated_tests_path,
      lint_report: result.manifest.validation.lint_report_path,
      explanation: result.manifest.validation.explanation_path,
      static_test_report: result.manifest.validation.static_test_report_path,
      lint_summary: result.manifest.validation.lint_summary,
      blocking_lint_issues: result.manifest.validation.blocking_lint_issues,
      static_test_summary: result.manifest.validation.static_test_summary,
      live_tests_pending: result.manifest.validation.live_tests_pending,
      unresolved_authority: result.manifest.unresolved_authority,
      diagnostics: result.manifest.diagnostics,
      active_tools_changed: false,
      source_database_changed: false,
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(formatSafeActionValidation(payload));
    return payload.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof SafeActionValidationError) || !args.includes("--json")) throw error;
    process.stdout.write(`${JSON.stringify({ ok: false, state: "blocked", diagnostics: error.diagnostics, active_tools_changed: false, source_database_changed: false }, null, 2)}\n`);
    return 1;
  }
}


async function watchSafeActionCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--project-root", "--json", "--once"]), "action watch");
  const sourcePath = positional(args, 0);
  if (!sourcePath) throw new Error("action watch requires a TypeScript Safe Action source path");
  const run = async () => {
    try {
      return await validateSafeActionCommand([sourcePath, ...flagWithValue(args, "--config"), ...flagWithValue(args, "--project-root"), ...(args.includes("--json") ? ["--json"] : [])]);
    } catch (error) {
      if (error instanceof SafeActionValidationError) {
        if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, state: "blocked", diagnostics: error.diagnostics }, null, 2)}\n`);
        else process.stderr.write(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  };
  const initial = await run();
  if (args.includes("--once")) return initial;
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const watchedPath = path.resolve(projectRoot, sourcePath);
  process.stderr.write(`Watching disabled Safe Action draft: ${watchedPath}\nActive tools will not reload or change. Press Ctrl+C to stop.\n`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for await (const event of fs.watch(watchedPath, { signal: controller.signal })) {
      if (event.eventType === "change" || event.eventType === "rename") await run();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).name !== "AbortError") throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}


async function safeActionStatusCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--project-root", "--json"]), "action status");
  const status = await safeActionStatus(optionalArg(args, "--project-root"));
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: true, ...status }, null, 2)}\n`);
  else process.stdout.write([
    "Synapsor Safe Action status",
    `Draft: ${status.draft ? `${status.draft.action_name} (${status.draft.state}, ${status.draft.draft_contract_digest})` : "none"}`,
    `Active: ${status.active ? `${status.active.action_name} (${status.active.contract_digest})` : "not managed by Safe Action activation"}`,
    `Draft matches active: ${status.draft_matches_active ? "yes" : "no"}`,
    "Activation is available only in the secured localhost Workbench, never through MCP or this CLI command.",
    "",
  ].join("\n"));
  return 0;
}


function formatSafeActionValidation(input: {
  ok: boolean;
  action_name: string;
  draft_digest: string;
  draft_contract: string;
  generated_tests: string;
  lint_report: string;
  explanation: string;
  static_test_report: string;
  lint_summary: { errors: number; warnings: number; info: number };
  blocking_lint_issues: number;
  static_test_summary: { passed: number; failed: number; total: number };
  live_tests_pending: string[];
  unresolved_authority: string[];
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}): string {
  return [
    `Synapsor Safe Action draft: ${input.ok ? "valid" : "blocked"}`,
    `Action: ${input.action_name}`,
    `Disabled draft digest: ${input.draft_digest}`,
    `Canonical draft: ${input.draft_contract}`,
    `Generated contract tests: ${input.generated_tests}`,
    `Strict incremental lint: ${input.blocking_lint_issues === 0 ? "PASS" : "BLOCKED"} (${input.lint_summary.errors} error / ${input.lint_summary.warnings} warning / ${input.lint_summary.info} info; inherited warnings remain visible)`,
    `Static generated tests: ${input.static_test_summary.failed === 0 ? "PASS" : "FAIL"} (${input.static_test_summary.passed}/${input.static_test_summary.total})`,
    `Live staging tests pending: ${input.live_tests_pending.length}`,
    `Lint report: ${input.lint_report}`,
    `Reviewer explanation: ${input.explanation}`,
    `Static test report: ${input.static_test_report}`,
    `Warnings: ${input.diagnostics.filter((item) => item.severity === "warning").length}`,
    ...(input.unresolved_authority.length ? ["Unresolved authority:", ...input.unresolved_authority.map((item) => `  - ${item}`)] : []),
    "Active Runner tools changed: no",
    "Source database changed: no",
    input.ok
      ? "Next: open the secured localhost Workbench and review the exact digest/effect before activation."
      : "Next: resolve every blocking lint/test finding, then validate a new disabled draft.",
    "",
  ].join("\n");
}


function flagWithValue(args: string[], flag: string): string[] {
  const value = optionalArg(args, flag);
  return value ? [flag, value] : [];
}


export function preferredDetectedDatabaseEnv(names: string[], env: NodeJS.ProcessEnv): string | undefined {
  const available = names.filter((name) => envValue(env, name));
  const preference = ["DATABASE_URL", "SYNAPSOR_DATABASE_READ_URL", "POSTGRES_URL", "POSTGRESQL_URL", "MYSQL_URL", "DB_URL"];
  return preference.find((name) => available.includes(name)) ?? available.find((name) => !name.includes("WRITE"));
}

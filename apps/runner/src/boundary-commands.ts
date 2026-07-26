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
  activateExplorationBoundary,
  explorationBoundaryCandidateDigest,
  type ExplorationBoundaryDraft,
  type GenerationLock
} from "./auto-boundary.js";
import { cliCommandName } from "./cli-command-meta.js";
import { readJsonFileWithLocation } from "./cli-files.js";
import { shellQuote } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { redactCliErrorMessage } from "./cli-logging.js";
import { assertKnownOptions, envValue, optionalArg, positional } from "./cli-options.js";
import { readRuntimeConfig } from "./cli-project.js";
import {
  readGuidedOnboardingState
} from "./guided-project.js";
import {
  boundaryReviewDecisions,
  createBoundaryReviewProgress,
  readBoundaryReviewProgress,
  saveBoundaryReviewProgress
} from "./local-ui.js";
import { displayPath } from "./onboarding.js";
import { resolveOperatorIdentity, verifyJwtOperatorProof, verifySignedOperatorProof, type OperatorIdentityConfig } from "./operator-identity.js";
import { resolveSynapsorProject } from "./project-resolution.js";
import { compileSafeActionDraft, safeActionStatus, SafeActionValidationError, scaffoldSafeAction } from "./safe-action.js";


type BoundaryReviewBundle = {
  schema_version: "synapsor.boundary-review-bundle.v1";
  candidate_digest: `sha256:${string}`;
  bundle_digest: `sha256:${string}`;
  activation: "disabled_unreviewed";
  authority: {
    source: string;
    deployment_profile: "development" | "staging";
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


export async function boundaryReviewCommand(args: string[]): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--project-root", "--output", "--json", "--confirm", "--actor"]),
    "boundary review",
  );
  if (args.includes("--confirm") && args.includes("--json")) {
    throw new Error("Interactive boundary review cannot use --json; confirm decisions in a terminal, then export JSON.");
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  let context = await loadBoundaryReviewContext(projectRoot);
  if (args.includes("--confirm")) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Interactive boundary review requires a real terminal. For automation, export a review bundle and use boundary activate --headless with a verified signed_key or jwt_oidc identity.",
      );
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.stdout.write(formatBoundaryReviewSummary(context.bundle));
      for (const decision of context.bundle.decisions.filter((item) => !item.confirmed)) {
        process.stdout.write([
          "",
          `Decision: ${decision.decision}`,
          `Stable ID: ${decision.id}`,
          `Reviewed-input digest: ${decision.input_digest}`,
          "",
        ].join("\n"));
        const answer = (await rl.question(`Type CONFIRM ${decision.id} to confirm this exact decision: `)).trim();
        if (answer !== `CONFIRM ${decision.id}`) {
          throw new Error(`Boundary review stopped before confirming ${decision.id}; no new confirmations were saved.`);
        }
      }
      let actor = optionalArg(args, "--actor")?.trim();
      if (!actor) actor = (await rl.question("Human reviewer identity (audit label, not a password): ")).trim();
      if (!actor) throw new Error("Boundary review requires a non-empty human reviewer identity.");
      const progress = createBoundaryReviewProgress({
        draft: context.draft,
        candidate: context.candidate,
        confirmedDecisions: context.draft.unresolved_decisions,
        previous: context.progress,
        actor,
        revision: (context.progress?.revision ?? 0) + 1,
      });
      await saveBoundaryReviewProgress(projectRoot, progress);
      context = await loadBoundaryReviewContext(projectRoot);
    } finally {
      rl.close();
    }
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
  } else if (!output || args.includes("--confirm")) {
    process.stdout.write(formatBoundaryReviewSummary(context.bundle));
  }
  return 0;
}


export async function boundaryActivateCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
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
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Noninteractive boundary activation requires --headless and a verified signed_key or jwt_oidc operator identity.");
    }
    if (context.bundle.outstanding_decision_ids.length > 0) {
      throw new Error(
        `Boundary activation is blocked by ${context.bundle.outstanding_decision_ids.length} unresolved decision(s). Run boundary review --confirm first.`,
      );
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.stdout.write(formatBoundaryReviewSummary(context.bundle));
      if (!confirmation) confirmation = (await rl.question(`Type ${expectedConfirmation} to activate this exact local boundary: `)).trim();
      if (!actor) actor = (await rl.question("Human operator identity (audit label, not a password): ")).trim();
    } finally {
      rl.close();
    }
    if (confirmation !== expectedConfirmation) throw new Error(`Activation requires the exact confirmation ${expectedConfirmation}.`);
    if (!actor) throw new Error("Activation requires a non-empty human operator identity.");
    operator = { subject: actor, provider: "interactive_terminal", verified: false };
  }

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
    });
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
        summary: "Verified operator activated reviewed local authoring authority",
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
      : `Activated exact local authoring boundary ${active.activation.digest} for ${operator.subject}.\nSource database changed: no.\n`);
    return 0;
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
  const candidate = progress?.candidate ?? draft;
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
    bundle_digest: canonicalJsonDigest(core),
  };
  return { boundaryRoot, draft, candidate, lock, progress, bundle };
}


function formatBoundaryReviewSummary(bundle: BoundaryReviewBundle): string {
  const confirmed = bundle.decisions.length - bundle.outstanding_decision_ids.length;
  return [
    "Scoped Explore boundary review",
    `  exact digest: ${bundle.candidate_digest}`,
    `  profile: ${bundle.authority.deployment_profile} (local authoring only)`,
    `  resources: ${bundle.candidate.pack.resources.length}`,
    `  decisions confirmed: ${confirmed}/${bundle.decisions.length}`,
    `  outstanding: ${bundle.outstanding_decision_ids.length}`,
    `  source database changed: no`,
    ...(bundle.outstanding_decision_ids.length
      ? ["  next: review these exact decision IDs:", ...bundle.outstanding_decision_ids.map((id) => `    - ${id}`)]
      : ["  next: activate this exact digest from the operator plane"]),
    "",
  ].join("\n");
}


function assertCurrentBoundaryReviewBundle(
  supplied: BoundaryReviewBundle,
  current: BoundaryReviewBundle,
): void {
  if (supplied.schema_version !== "synapsor.boundary-review-bundle.v1") {
    throw new Error("Unsupported boundary review bundle version.");
  }
  const { bundle_digest: suppliedDigest, ...suppliedCore } = supplied;
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

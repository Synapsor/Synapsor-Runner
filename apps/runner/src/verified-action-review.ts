import { actionRuleEffectLines, actionRuleEffectInventory } from "@synapsor-runner/action-rules";
import { actionSubjectCompatibility } from "./action-subject-compatibility.js";
import process from "node:process";
import { assessWorkerLaunch, workerLaunchLines } from "./worker-launch.js";
import type { RuntimeConfig, RuntimeSupervisedWorkerOutcomePolicy } from "@synapsor-runner/mcp-server";
import path from "node:path";
import { reviewSemanticReceiptSetup } from "./semantic-receipt-setup.js";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { loadActivatedExplorationBoundaries, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import {
  deactivateActionRuleAuthority,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
} from "./action-rule-authority.js";
import { renderBoundaryMapTable } from "./boundary-map-presentation.js";
import type {
  BoundaryAccessNotice,
  BoundaryReviewInteractiveSession,
} from "./boundary-cli-picker.js";
import { cliCommandName } from "./cli-command-meta.js";
import { shellQuote } from "./cli-format.js";
import { actionRuleDiscoveryMetadata } from "@synapsor-runner/action-rules";
import { redactCliErrorMessage } from "./cli-logging.js";
import { clearPausedExecutionSetup, executionSetupProblem, savePausedExecutionSetup, SemanticWriterPostureError, type ExecutionSetupProblem } from "./semantic-execution-setup.js";
import { exportWriterProvisioning, writerPolicyRepairSummary, type WriterProvisioningPlan } from "./writer-provisioning.js";
import { renderRunnerResultPanel } from "./runner-result-panel.js";
import { reviewActionRevisionImpact } from "./action-revision-impact.js";
import { readSavedActionJobReview } from "./saved-action-job-review.js";
import { revalidateSavedActionReadDependencies, savedActionReadReviewState } from "./action-read-recovery.js";
import { inspectReviewerGrantRemovalImpact, reviewerGrantImpactLines } from "./reviewer-grant-impact.js";
import {
  verifySemanticExecutionReadPosture,
  activateSemanticActionRuntime,
  disableSemanticSupervisedExecution,
  enableSemanticSupervisedExecution,
  previewSemanticSupervisedExecution,
  prepareSemanticWriterHandoff,
  readSemanticSupervisedExecutionState,
  readSemanticExecutionReviewDefaults,
  semanticDedicatedWriterEnvironment,
  recoverSemanticActionRuntime,
  executionReReviewOutcomesForActionActivation,
  semanticExecutionConfirmation,
} from "./semantic-action-deployment.js";

export type VerifiedActionManualRevision = {
  /** Opens only disabled manual authoring; it never confirms Read or Action activation. */
  run: () => Promise<BoundaryAccessNotice>;
};

export function verifiedActionManualRevisionChoice(manualRevision: VerifiedActionManualRevision | undefined) {
  return manualRevision ? [{
    value: "manual_revision",
    label: "Edit business rules manually",
    detail: "The current draft and live permissions stay unchanged until a separate review activates a disabled replacement.",
  }] : [];
}

export async function reviewVerifiedActionAuthority(input: {
  projectRoot: string;
  baseConfigPath?: string;
  boundaryName: string;
  session: BoundaryReviewInteractiveSession;
  draft?: ActionRuleAuthorityDraftV1;
  active?: ActionRuleAuthorityActivationV1;
  env?: NodeJS.ProcessEnv;
  inspectDatabaseFn?: typeof inspectDatabase;
  modelRevision?: {
    label: string;
    detail: string;
    run: () => Promise<BoundaryAccessNotice>;
  };
  manualRevision?: VerifiedActionManualRevision;
  /** Opens the existing exact Read confirmation, then returns to this review. */
  reviewRead?: () => Promise<void>;
  /** Navigation supplied by the CLI composition layer, never an authority grant. */
  clientSetup?: () => Promise<number>;
}): Promise<BoundaryAccessNotice> {
  while (true) {
    try {
      const recovered = await recoverSemanticActionRuntime({ projectRoot: input.projectRoot, env: input.env,
        draftName: input.draft?.authority.name ?? input.active?.authority.name });
      if (recovered.authority) input = { ...input, ...recovered.authority };
      return await reviewSavedVerifiedActionAuthority(input, recovered.readBoundaries);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !["POLICY_CONFIG_COMMIT_UNCONFIRMED", "POLICY_CONFIG_PUBLICATION_PENDING",
        "POLICY_CONFIG_RECOVERY_CLEANUP_PENDING", "POLICY_CONFIG_RECOVERY_CONFLICT", "POLICY_CONFIG_RECOVERY_INVALID"].includes(code)) throw error;
      const details = [redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
        "Recovery checks the original receipt; it never replays activation. Existing authority is not disabled by pausing."];
      input.session.rememberDetails?.("Action save recovery", details);
      const choice = await input.session.chooseOption?.("CHECK ACTION SAVE", [
        { value: "recover", label: "Check the saved activation receipt", detail: "Recover this exact attempt without activating again." },
        { value: "details", label: "View recovery details" },
        { value: "pause", label: "Pause and preserve the saved state" },
      ], { initialValue: "pause", context: ["The Action save needs recovery before another activation decision.", `Diagnostic: ${code}`] });
      if (choice === "details") { await input.session.showReviewDetails?.("Action save recovery", details); continue; }
      if (choice === "recover") continue;
      return { tone: "warning", title: "Action save recovery paused.", lines: [
        `Diagnostic: ${code}. Reopen Action review to check the exact receipt.`,
        "The saved state is preserved. Do not assume existing authority is disabled; no source request was executed here.",
      ] };
    }
  }
}

async function reviewSavedVerifiedActionAuthority(input: Parameters<typeof reviewVerifiedActionAuthority>[0],
  recoveredReads?: ActivatedExplorationBoundary[]): Promise<BoundaryAccessNotice> {
  const activeReads = recoveredReads ?? await loadActivatedExplorationBoundaries(input.projectRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const compatibility = input.draft || input.active ? actionSubjectCompatibility((input.draft ?? input.active)!.authority, activeReads) : undefined;
  const subjectConcerns = compatibility?.subjects.filter(s => !s.obtainable) ?? [];
  const subjectLines = subjectConcerns.flatMap(s => [`${s.outcome}/${s.binding}: ${s.code}.`, s.next_step!]);
  const draftReady = !subjectConcerns.length && (input.draft?.authority.rules.every((rule) => activeReads.some((boundary) =>
    boundary.pack.name === rule.read_boundary_name
    && boundary.activation.digest === rule.read_boundary_digest)) ?? false);
  const unavailableOutcomes = new Set(input.active?.authority.rules.filter((rule) => !activeReads.some((boundary) =>
    boundary.pack.name === rule.read_boundary_name && boundary.activation.digest === rule.read_boundary_digest))
    .map((rule) => rule.rule.outcome) ?? []);
  const unavailableNotice = "Verified Action authority is saved; Read dependency unavailable.";
  const canContinueClientSetup = Boolean(input.clientSetup && input.active && !unavailableOutcomes.size && !subjectConcerns.length
    && activeReads.length && activeReads.every(read => read.deployment_profile !== "production"));
  const current = input.draft ?? input.active;
  if (!current) {
    if (input.modelRevision) return input.modelRevision.run();
    return {
      tone: "warning",
      title: "No verified Action outcome is prepared.",
      lines: ["Use W and describe a job whose exact effect must be derived from current authoritative facts."],
      footer: "The existing Read permissions and source data are unchanged.",
    };
  }
  const needsReadRecheck = current.authority.rules.some(rule => !activeReads.some(read =>
    read.pack.name === rule.read_boundary_name && read.activation.digest === rule.read_boundary_digest));
  const oneReadDependency = current.authority.rules.every(rule => rule.read_boundary_name === input.boundaryName);
  const readReviewState = oneReadDependency
    ? await savedActionReadReviewState(input.projectRoot, input.boundaryName, activeReads, input.env) : "unavailable";
  const canRecheckRead = needsReadRecheck && readReviewState === "active";
  const needsReadReview = readReviewState === "pending";
  let executionState = await readSemanticSupervisedExecutionState({
    projectRoot: input.projectRoot,
    env: input.env,
  });
  const executionReReviewOutcomes = input.draft
    ? executionReReviewOutcomesForActionActivation({ active: input.active, draft: input.draft, execution: executionState })
    : [];
  const enabledExecutionOutcomes = () => new Set(
    executionState.enabled && input.active
      ? executionState.policies
        .filter((policy) => policy.action_boundary_digest === input.active!.authority.action_boundary.digest)
        .map((policy) => policy.outcome)
      : [],
  );
  const activeSummary = input.active
    ? verifiedActionAuthoritySummary(
        input.active,
        unavailableOutcomes.size ? "SAVED AUTHORITY - READ DEPENDENCY UNAVAILABLE" : "ACTIVE AUTHORITY",
        enabledExecutionOutcomes(),
        input.session.terminalColumns,
        unavailableOutcomes,
      )
    : [];
  const draftSummary = input.draft
    ? verifiedActionAuthoritySummary(
        input.draft,
        input.active ? "REPLACEMENT DRAFT - NOT ACTIVE" : "DISABLED DRAFT",
        new Set(),
        input.session.terminalColumns,
      )
    : [];
  const requestImpact = await reviewActionRevisionImpact(input);
  const jobReview = await readSavedActionJobReview({ projectRoot: input.projectRoot, boundaryName: input.boundaryName,
    currentOutcomes: current.authority.rules.map((rule) => rule.rule.outcome), env: input.env });
  const reviewedNotice = (value: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1, active: boolean, configPath?: string) => {
    const notice = verifiedActionNotice(value, active, configPath);
    return { ...notice, lines: [...jobReview.summary, ...notice.lines] };
  };
  const removedOutcomes = input.active && input.draft ? input.active.authority.rules.map(rule => rule.rule.outcome)
    .filter(outcome => !input.draft!.authority.rules.some(rule => rule.rule.outcome === outcome)) : [];
  const removalImpact = async (outcomes = removedOutcomes) => input.active && outcomes.length
    ? reviewerGrantImpactLines(await inspectReviewerGrantRemovalImpact({ projectRoot: input.projectRoot,
      activeDigest: input.active.digest, removedOutcomes: outcomes, env: input.env }), input.projectRoot) : [];
  const summary = [
    ...await removalImpact(),
    ...jobReview.summary,
    ...subjectLines,
    ...(needsReadReview ? ["Review the saved read access first; its latest revision is not active.",
      "Your business rules stay saved. Read approval is separate and does not enable changes or execution.",
      ...(input.reviewRead ? [] : [`Open: ${cliCommandName()} boundary review --project-root ${shellQuote(input.projectRoot)} --access`])] : []),
    ...(canRecheckRead ? ["Access was reviewed at a newer revision. Recheck the saved changes against it before deciding on activation.",
      "Runner will inspect metadata and preserve every business rule in a disabled replacement. It will not run a request or enable execution."] : []),
    ...activeSummary,
    ...(activeSummary.length && draftSummary.length ? [""] : []),
    ...draftSummary,
    ...requestImpact.slice(0, 3),
    "The agent supplies an outcome and opaque subject reference only. Runner reloads facts and derives the effect.",
    ...(unavailableOutcomes.size ? [
      `Read dependency unavailable: ${[...unavailableOutcomes].join(", ")}. These outcomes cannot be used or executed.`,
      "Their activation records are retained. Review the linked Read authority; opening these details does not restore access.",
    ] : []),
    ...(executionReReviewOutcomes.length ? [
      `Execution review required after activation: ${executionReReviewOutcomes.join(", ")}.`,
      "The complete Action Boundary digest changes. Existing supervised execution is not carried forward; each listed outcome needs separate writer review after proposal authority activation.",
    ] : []),
    input.draft
      ? draftReady
        ? input.active
          ? unavailableOutcomes.size ? "The saved activation is unchanged until you separately confirm this exact replacement."
            : "The active authority remains live until you separately confirm this exact replacement."
          : "Disabled revision is ready for its separate proposal-authority confirmation."
        : subjectConcerns.length ? "This revision is not ready for the four-tool client: review its subject acquisition requirement. Existing authority remains unchanged."
        : input.active
          ? canRecheckRead ? "The saved activation is unchanged. Recheck its replacement against the reviewed access before activation."
            : `The saved activation is unchanged. Activate the exact linked Read Boundary ${input.boundaryName} before reviewing its replacement.`
          : `Activate the exact linked Read Boundary ${input.boundaryName} before this Action revision.`
      : unavailableOutcomes.size ? "Only outcomes with current reviewed Read dependencies remain usable. Approval and apply remain separate."
        : "This verified Action Boundary is active. Approval and apply remain separate.",
  ];
  if (!input.session.chooseOption) {
    if (!input.draft || !draftReady) {
      return {
        tone: input.active && !input.draft && !unavailableOutcomes.size ? "success" : "warning",
        title: unavailableOutcomes.size ? unavailableNotice : input.active && input.draft
          ? "Active verified authority is unchanged; its replacement is not ready."
          : input.active
            ? "Verified Action Boundary is active."
            : "Verified Action Boundary is not ready to activate.",
        lines: summary,
      };
    }
    const accepted = await (input.session.confirmActivation ?? input.session.confirm)(
      `Activate verified Action Boundary "${input.draft.authority.action_boundary.name}"?`,
      { context: [...await removalImpact(), ...input.draft.authority.rules.flatMap(actionRuleEffectLines), ...summary] },
    );
    if (!accepted) return reviewedNotice(input.draft, false);
    const activated = await activateSemanticActionRuntime({
      projectRoot: input.projectRoot,
      ...(input.baseConfigPath ? { baseConfigPath: input.baseConfigPath } : {}),
      draft: input.draft,
      actor: localInteractiveActor(),
      env: input.env,
    });
    return reviewedNotice(activated.activation, true, activated.config_path);
  }
  while (true) {
    const choice = await input.session.chooseOption(
      "VERIFIED ACTION BOUNDARY",
      [
        ...(jobReview.details.length ? [{ value: "details_pending_job", label: jobReview.detailsLabel ?? "View unfinished saved work",
          detail: "Inspect saved job status without changing this review or contacting the model." }] : []),
        ...(needsReadReview && input.reviewRead ? [{ value: "review_read", label: "Review saved read access",
          detail: "Review who can see which information, then return to these saved changes. Activation requires your separate confirmation." }] : []),
        ...(canRecheckRead ? [{ value: "revalidate_read", label: "Recheck saved changes against reviewed access",
          detail: "Keep the same business rules; verify current metadata and prepare a disabled replacement for review." }] : []),
        ...(input.draft
          ? [{
              value: "activate",
              label: draftReady ? "Activate this exact proposal authority"
                : canRecheckRead ? "Recheck saved changes first" : "Activate linked Read Boundary first",
              detail: draftReady
                ? "Agents may nominate these outcomes; approval and apply remain separate."
                : `This revision is locked to the exact Read Boundary ${input.boundaryName}.`,
              disabled: !draftReady,
            }]
          : []),
        ...(input.draft
          ? [{
              value: "details_draft",
              label: input.active ? "View replacement draft details" : "View exact draft rules and examples",
              detail: "Shows private fields, refusals, examples, and digests for the disabled revision.",
            }]
          : []),
        ...(input.active
          ? [{
              value: "details_active",
              label: unavailableOutcomes.size ? "View saved activation details" : "View active authority details",
              detail: "Shows the exact saved rules; current Read dependencies still determine availability.",
            }]
          : []),
        ...(canContinueClientSetup ? [{ value: "client_setup", label: "Continue client setup",
          detail: "Connect Claude Code, Cursor or VS Code, review trusted identity and worker startup. Pending drafts stay saved; this choice grants no authority." }] : []),
        ...verifiedActionManualRevisionChoice(input.manualRevision),
        ...(input.modelRevision
          ? [{
              value: "model_revision",
              label: input.modelRevision.label,
              detail: input.modelRevision.detail,
            }]
          : []),
        ...(input.active?.authority.action_boundary.rules.flatMap((rule) => {
          if (rule.writeback.mode !== "direct_sql" || rule.writeback.supervised_worker !== "allowed") return [];
          const enabled = enabledExecutionOutcomes().has(rule.outcome);
          if (!enabled && unavailableOutcomes.has(rule.outcome)) return [];
          return [{
            value: `${enabled ? "disable" : "enable"}_execution:${rule.outcome}`,
            label: enabled
              ? `Disable supervised execution for ${rule.outcome}`
              : `Review supervised execution for ${rule.outcome}`,
            detail: enabled
              ? "Stops new worker leases for this exact outcome; proposal authority stays active."
              : "Separately inspect and bind one least-privilege writer. No write runs during setup.",
          }];
        }) ?? []),
        ...(input.active
          ? [{
              value: "deactivate",
              label: "Deactivate verified proposal authority",
              detail: "Stops app.request_change for these outcomes; source data is unchanged.",
            }]
          : []),
        { value: "back", label: "Back" },
      ],
      {
        initialValue: needsReadReview && input.reviewRead ? "review_read" : canRecheckRead ? "revalidate_read" : input.draft && draftReady
          ? "activate"
          : input.draft
            ? "details_draft"
            : input.modelRevision
              ? "model_revision"
              : "details_active",
        context: summary,
      },
    );
    if (!choice || choice === "back") {
      return {
        tone: input.active && !input.draft && !unavailableOutcomes.size ? "success" : "warning",
        title: unavailableOutcomes.size ? unavailableNotice : input.active && input.draft
          ? "Active verified authority is unchanged; replacement remains disabled."
          : input.active
            ? "Verified Action Boundary remains active."
            : "Verified Action Boundary remains disabled.",
        lines: [
          ...jobReview.summary,
          ...(input.active && input.draft
            ? ["The active and replacement revisions remain separate."]
            : []),
          "No authority or source data changed.",
        ],
      };
    }
    if (choice === "review_read" && needsReadReview && input.reviewRead) {
      await input.reviewRead();
      return reviewVerifiedActionAuthority(input);
    }
    if (choice === "client_setup" && canContinueClientSetup && input.clientSetup) {
      try {
        const result = await input.clientSetup();
        if (result !== 0) throw new Error(`Client setup did not finish (exit ${result}). Resolve the reported connection or configuration problem, then retry.`);
      } catch (error) {
        const details = [redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
          "Client setup did not finish. Existing rules and pending drafts remain saved; no activation is needed merely to reopen setup.",
          "Return to this review and choose Continue client setup to retry. Connection and worker readiness remain unverified."];
        input.session.rememberDetails?.("Client setup needs attention", details);
        if (input.session.showReviewDetails) await input.session.showReviewDetails("Client setup needs attention", details);
        else await input.session.chooseOption("CLIENT SETUP NEEDS ATTENTION", [{ value: "back", label: "Back to saved actions" }],
          { context: details, displayContext: true, initialValue: "back" });
      }
      // Setup may include separately confirmed execution changes. Reload rather
      // than presenting the state captured before that operator interaction.
      return reviewVerifiedActionAuthority(input);
    }
    if (choice === "revalidate_read" && canRecheckRead) {
      try {
        const replacement = await revalidateSavedActionReadDependencies({ projectRoot: input.projectRoot,
          boundaryName: input.boundaryName, current, env: input.env, inspect: input.inspectDatabaseFn });
        input.session.rememberDetails?.("Saved changes rechecked", [
          `${replacement.authority.rules.length} saved business rules recompiled against the current reviewed access.`,
          "Only a disabled replacement was saved. Business conditions, effects and approval limits are preserved.",
          "Existing activation and execution records are unchanged. Review this replacement and then its execution settings separately.",
        ]);
        return reviewVerifiedActionAuthority({ ...input, draft: replacement });
      } catch (error) {
        const details = [redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
          "No active permission or source data changed. Keep this work saved and resolve the named dependency before retrying."];
        input.session.rememberDetails?.("Saved changes need review", details);
        if (input.session.showReviewDetails) await input.session.showReviewDetails("Saved changes need review", details);
        else await input.session.chooseOption("SAVED CHANGES NEED REVIEW", [{ value: "back", label: "Back to the saved review" }],
          { context: details, displayContext: true, initialValue: "back" });
        continue;
      }
    }
    if (choice === "details_pending_job") {
      await input.session.chooseOption("UNFINISHED SAVED WORK", [{ value: "back", label: "Back to this Action review" }],
        { initialValue: "back", context: jobReview.details, displayContext: true });
      continue;
    }
    if (choice === "details_draft" && input.draft) {
      await input.session.chooseOption(
        input.active ? "EXACT REPLACEMENT DRAFT DETAILS" : "EXACT VERIFIED ACTION DETAILS",
        [{ value: "back", label: "Back to Action Boundary" }],
        {
          initialValue: "back",
          context: [...requestImpact, ...verifiedActionAuthorityDetails(input.draft, input.session.terminalColumns)],
        },
      );
      continue;
    }
    if (choice === "details_active" && input.active) {
      await input.session.chooseOption(
        "EXACT ACTIVE ACTION DETAILS",
        [{ value: "back", label: "Back to Action Boundary" }],
        {
          initialValue: "back",
          context: verifiedActionAuthorityDetails(input.active, input.session.terminalColumns),
        },
      );
      continue;
    }
    if (choice === "manual_revision" && input.manualRevision) {
      return input.manualRevision.run();
    }
    if (choice === "model_revision" && input.modelRevision) {
      return input.modelRevision.run();
    }
    if (choice.startsWith("enable_execution:") && input.active && !unavailableOutcomes.has(choice.slice("enable_execution:".length))) {
      const outcome = choice.slice("enable_execution:".length);
      const notice = await reviewSemanticSupervisedExecution({
        projectRoot: input.projectRoot,
        active: input.active,
        activeReads,
        outcome,
        session: input.session,
        ...(input.env ? { env: input.env } : {}),
        ...(input.inspectDatabaseFn ? { inspectDatabaseFn: input.inspectDatabaseFn } : {}),
      });
      if (notice) return notice;
      executionState = await readSemanticSupervisedExecutionState({ projectRoot: input.projectRoot, env: input.env });
      continue;
    }
    if (choice.startsWith("disable_execution:") && input.active) {
      const outcome = choice.slice("disable_execution:".length);
      const confirmed = await input.session.confirm(
        `Disable supervised source execution for ${outcome}?`,
        {
          defaultValue: false,
          context: [
            "New worker leases for this exact outcome will stop.",
            "Verified proposal authority, approvals, evidence, queued records, and source data remain unchanged.",
          ],
        },
      );
      if (!confirmed) continue;
      executionState = await disableSemanticSupervisedExecution({
        projectRoot: input.projectRoot,
        env: input.env,
        outcome,
        expectedActionBoundaryDigest: input.active.authority.action_boundary.digest,
      });
      return {
        tone: "success",
        title: "Supervised execution disabled.",
        lines: [
          `${outcome}: worker leases off; verified proposal authority remains active.`,
          "Approval records, evidence, and source data are unchanged.",
        ],
      };
    }
    if (choice === "deactivate" && input.active) {
      const confirmed = await input.session.confirm(
        `Deactivate verified Action Boundary "${input.active.authority.action_boundary.name}"?`,
        {
          defaultValue: false,
          context: [
            ...await removalImpact(input.active.authority.rules.map(rule => rule.rule.outcome)),
            "Agents will no longer be able to nominate these outcomes.",
            "Existing proposals and evidence remain; approval, apply, and source data are unchanged.",
          ],
        },
      );
      if (!confirmed) continue;
      await deactivateActionRuleAuthority(input.projectRoot);
      return {
        tone: "success",
        title: "Verified Action Boundary deactivated.",
        lines: ["Proposal authority is off. Approval, apply, evidence, and source data are unchanged."],
      };
    }
    if (choice === "activate" && input.draft && draftReady) {
      const confirmed = await (input.session.confirmActivation ?? input.session.confirm)(
        `Activate verified Action Boundary "${input.draft.authority.action_boundary.name}"?`,
        {
          context: [
            ...await removalImpact(),
            ...input.draft.authority.rules.flatMap(actionRuleEffectLines),
            ...summary,
            "This grants proposal authority only. It cannot approve, apply, or write source data.",
            "Use exact details to inspect the immutable digest before confirming.",
          ],
        },
      );
      if (!confirmed) continue;
      const activated = await activateSemanticActionRuntime({
        projectRoot: input.projectRoot,
        ...(input.baseConfigPath ? { baseConfigPath: input.baseConfigPath } : {}),
        draft: input.draft,
        actor: localInteractiveActor(),
        env: input.env,
      });
      return reviewedNotice(activated.activation, true, activated.config_path);
    }
  }
}

export async function reviewSemanticSupervisedExecution(input: {
  projectRoot: string;
  active: ActionRuleAuthorityActivationV1;
  activeReads: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>>;
  outcome: string;
  session: BoundaryReviewInteractiveSession;
  env?: NodeJS.ProcessEnv;
  inspectDatabaseFn?: typeof inspectDatabase;
}): Promise<BoundaryAccessNotice | undefined> {
  for (;;) {
    const result = await reviewSemanticSupervisedExecutionAttempt(input);
    if (result?.tone !== "danger" || !input.session.chooseOption) return result;
    const problem = result.problem ?? executionSetupProblem(new Error(result.lines.join("\n")));
    const publication = problem.publication_state !== undefined;
    const revalidation = problem.code === "SEMANTIC_ACTION_READ_REVIEW_REQUIRED";
    const canPrepareWriter = !publication && !revalidation;
    const detailsTitle = publication ? "Execution save recovery" : revalidation ? "Saved job revalidation" : "Writer requirements";
    input.session.rememberDetails?.(detailsTitle, problem.details);
    let recovery: string | undefined;
    for (;;) {
      recovery = await input.session.chooseOption(publication ? "Execution save needs recovery" : "Execution needs a deployment fix", [
        ...(canPrepareWriter ? [{ value: "export", label: "Prepare administrator instructions",
          detail: "Export exact grants and inspected policy/trigger evidence for an administrator. No database permissions change." }] : []),
        { value: "retry", label: publication ? "Recover the saved attempt and reopen review" : revalidation ? "Recheck after saved-job revalidation" : "Recheck the writer and continue setup",
          detail: publication ? "Check the exact saved receipt without replaying activation or executing a request." : "After repair, verify the new configured connection. No request executes." },
        { value: "details", label: publication ? "Inspect the saved recovery details" : revalidation ? "Show how to revalidate this saved job" : "Inspect the exact writer requirements" },
        { value: "pause", label: "Save and pause this outcome's execution setup", detail: publication ? "Preserve the recovery record. Pausing does not disable existing execution."
          : revalidation ? "Keep the rules and authority records; resume the same job to review the changed database contract."
            : "Preserve the existing activation records. This check enables no execution and runs no request." },
      ], { initialValue: result.provisioning ? "export" : "pause", displayContext: true, context: [`Outcome: ${input.outcome}`, problem.summary,
        `Verification: ${/STALE|CHANGED|REVIEW_REQUIRED/u.test(problem.code) ? "STALE / requires current review" : problem.code === "SEMANTIC_ACTION_WRITER_POSTURE_INVALID" ? "FAILED" : "UNAVAILABLE / incomplete"}. Execution was not authorized by this check.`,
        `Diagnostic: ${problem.code}.`, ...problem.details.slice(0, 4)] });
      if (recovery === "export" && canPrepareWriter) {
        try {
          const plan = result.provisioning ?? (await prepareSemanticWriterHandoff({
            projectRoot: input.projectRoot, outcome: input.outcome,
            reads: input.activeReads.map((read) => ({ pack: read.pack, digest: read.activation.digest })),
            env: input.env, inspect: input.inspectDatabaseFn,
          })).plan;
          const directory = await exportWriterProvisioning(input.projectRoot, plan);
          const lines = [`Administrator handoff: ${directory}`, "Review README.md, requirements.json and grants.sql with your database administrator.",
            ...writerPolicyRepairSummary(plan),
            `Keep ${plan.read_env ?? "the saved read connection"} unchanged; configure the dedicated writer in ${plan.writer_env}. Never replace the reader with the restricted writer.`,
            "The new role starts NOLOGIN. Scoped policies and helper access still need review; do not reuse or revoke the shared writer.",
            "If RLS changes, resume the same start command through the reader with --rescan and revalidate the saved Read/Action job. Otherwise recheck the separate writer here. This export changes no authority or database."];
          problem.details.push("", ...lines);
          input.session.rememberDetails?.(detailsTitle, problem.details);
          await input.session.showReviewDetails?.("Dedicated writer handoff saved", lines);
        } catch (error) {
          await input.session.showReviewDetails?.("Writer handoff was not exported", [redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
            "The pending review and database are unchanged. Exact requirements remain available."]);
        }
        continue;
      }
      if (recovery !== "details") break;
      await input.session.showReviewDetails?.(detailsTitle, problem.details);
    }
    if (recovery === "retry") continue;
    await savePausedExecutionSetup(input.projectRoot, { action_digest: input.active.authority.action_boundary.digest,
      outcome: input.outcome, problem });
    if (publication) return { tone: "warning", title: "Execution review paused.", lines: [problem.summary,
      "Existing execution authority was not disabled. The recovery record is preserved; no source request ran during setup."],
      footer: "Resume execution review with the same start command to recover this exact save." };
    return { tone: "warning", title: "Execution setup paused.",
      lines: [problem.summary, "Read and proposal activation records are preserved. Automatic completion for this setup remains unfinished."],
      footer: revalidation ? "Resume the same start command with --rescan and choose Revalidate the saved job against changed database. Do not reset or re-enter the job."
        : "Resume execution setup with the same start command after repairing the write connection. Saved writer requirements remain available." };
  }
}

async function reviewSemanticSupervisedExecutionAttempt(input: Parameters<typeof reviewSemanticSupervisedExecution>[0]): Promise<(BoundaryAccessNotice & { problem?: ExecutionSetupProblem; provisioning?: WriterProvisioningPlan }) | undefined> {
  const env = input.env ?? process.env;
  let defaults: Awaited<ReturnType<typeof readSemanticExecutionReviewDefaults>>;
  try { defaults = await readSemanticExecutionReviewDefaults(input); }
  catch (error) {
    const problem = executionSetupProblem(error);
    return { tone: "danger", title: "Execution was not enabled.", lines: [problem.summary], problem };
  }
  const dedicatedEnv = semanticDedicatedWriterEnvironment(input.outcome);
  let writeUrlEnv = (env[dedicatedEnv]?.trim() ? dedicatedEnv : undefined) ?? defaults?.write_url_env
    ?? (env.SYNAPSOR_DATABASE_WRITE_URL?.trim() ? "SYNAPSOR_DATABASE_WRITE_URL" : undefined);
  try {
    const selected = await reviewSemanticReceiptSetup({ ...input,
      configPath: path.join(input.projectRoot, "synapsor.actions.runner.json"), writeUrlEnv: writeUrlEnv ?? dedicatedEnv });
    if (!selected) return undefined;
    if (selected.reviewed) writeUrlEnv = selected.writeUrlEnv;
  } catch (error) {
    const problem = executionSetupProblem(error);
    return { tone: "danger", title: "Execution was not enabled.", lines: [problem.summary], problem };
  }
  const workerIdentity = defaults ? defaults.worker_identity : "semantic_action_worker";
  let configured = Boolean(writeUrlEnv && env[writeUrlEnv]?.trim());
  if (configured && input.session.chooseOption) {
    const choice = await input.session.chooseOption("Check your write connection", [
      { value: "check", label: "Check the configured write connection", detail: "Verify its permissions; do not enable execution or run a request." },
      { value: "change", label: "Use another configured connection" },
      { value: "pause", label: "Set up this outcome later" },
    ], { initialValue: "check", displayContext: true, context: [`Outcome: ${input.outcome}`, `Connection: ${writeUrlEnv} is set (value hidden). Execution authorization comes after verification.`,
      ...(defaults ? ["The saved reference is a review default only, not current execution authority."] : [])] });
    if (!choice || choice === "pause") return undefined;
    configured = choice === "check";
  } else configured = false;
  if (!configured) {
    if ((!writeUrlEnv || !env[writeUrlEnv]?.trim()) && input.session.chooseOption) {
      for (;;) {
        const choice = await input.session.chooseOption("Set up database changes", [
          { value: "choose", label: "Choose a write connection", detail: "Select its environment variable; Runner checks the actual permissions before asking to enable execution." },
          { value: "export", label: "Prepare administrator instructions", detail: "Inspect metadata through the read connection and export exact requirements for this saved action. No database grants are changed." },
          { value: "pause", label: "Save and continue later", detail: "Keep this job, its rules and active permissions. No execution is enabled by this setup." },
        ], { initialValue: "choose", displayContext: true, context: renderRunnerResultPanel({
          result: "A write connection still needs to be selected and checked.",
          checked: `The saved action ${input.outcome} has reached execution review.`,
          changed: "No database permissions or source records changed.",
          notChecked: "Write grants, scoped policies and worker readiness.",
          next: "Choose an existing connection, or prepare instructions for your database administrator.",
        }, reviewTableWidth(input.session.terminalColumns ?? 80)) });
        if (choice === "choose") break;
        if (choice !== "export") return undefined;
        try {
          const checked = await prepareSemanticWriterHandoff({ projectRoot: input.projectRoot, outcome: input.outcome,
            reads: input.activeReads.map((read) => ({ pack: read.pack, digest: read.activation.digest })),
            writeUrlEnv, env: input.env, inspect: input.inspectDatabaseFn });
          const directory = await exportWriterProvisioning(input.projectRoot, checked.plan);
          writeUrlEnv = checked.plan.writer_env;
          const details = [`Administrator handoff: ${directory}`, "Read README.md, requirements.json and grants.sql.",
            ...writerPolicyRepairSummary(checked.plan),
            `Inspected metadata using ${checked.inspected_connection_env}; writer access has NOT been verified.`,
            `Keep ${checked.plan.read_env ?? "the saved read connection"} unchanged. Configure the new writer ONLY in ${checked.plan.writer_env}.`,
            "Requirements include version advances, verification reads and row-lock privileges, not just business fields.",
            "After administrator setup, select the write connection here for live verification. If schema/RLS changes, resume the same start command with --rescan and revalidate the saved job.",
            "No source rows, grants, activation records or rules changed."];
          input.session.rememberDetails?.("Administrator instructions", details);
          await input.session.showReviewDetails?.("Administrator instructions prepared", details);
        } catch (error) {
          const problem = executionSetupProblem(error);
          input.session.rememberDetails?.("Administrator instructions unavailable", problem.details);
          await input.session.showReviewDetails?.("Administrator instructions unavailable", [problem.summary,
            "The saved job is unchanged. Restore the read connection and retry, or save and continue later.", ...problem.details]);
        }
      }
    }
    const writeUrlAnswer = await input.session.promptText(
      writeUrlEnv ? `Write connection variable (Enter uses ${writeUrlEnv})`
        : "Write connection variable (Enter defers this outcome)",
      {
        context: [
          `Outcome: ${input.outcome}`,
          "Your read-only connection cannot execute changes. Configure a separate write connection, then enter its variable name here, not its URL.",
          ...(defaults ? ["The saved reference is a review default only; its current credential and permissions will be checked."] : []),
          "This checks permissions only. Enabling execution and starting a worker are separate decisions.",
        ],
      },
    );
    if (writeUrlAnswer === undefined) return undefined;
    writeUrlEnv = writeUrlAnswer.trim() || writeUrlEnv;
  }
  if (!writeUrlEnv) return undefined;
  let delayedWork: NonNullable<RuntimeSupervisedWorkerOutcomePolicy["delayed_work"]> | undefined = defaults?.delayed_work;
  let profile: "development" | "staging" | "production";
  let preview: Awaited<ReturnType<typeof previewSemanticSupervisedExecution>>;
  try {
    profile = semanticExecutionProfile(input.active, input.activeReads, input.outcome);
    preview = await previewSemanticSupervisedExecution({
      projectRoot: input.projectRoot,
      outcome: input.outcome,
      profile,
      writeUrlEnv,
      ...(delayedWork ? { delayedWork } : {}),
      ...(workerIdentity === undefined ? {} : { workerIdentity }),
      ...(input.env ? { env: input.env } : {}),
      ...(input.inspectDatabaseFn ? { inspect: input.inspectDatabaseFn } : {}),
    });
    await verifySemanticExecutionReadPosture({ projectRoot: input.projectRoot, outcome: input.outcome,
      activeReads: input.activeReads, env: input.env, inspect: input.inspectDatabaseFn });
    // Offer P1 only after the ordinary writer/receipt preview establishes the
    // required source-db posture. Existing Runner-ledger and unsupported
    // execution reviews keep their prior UI and cannot opt into delayed work.
    if (input.session.chooseOption && preview.receipts.authority === "source_db"
      && preview.receipts.provisioning === "precreated") {
    if (input.session.chooseOption) {
      const delayedChoice = await input.session.chooseOption("Permit delayed approval and dispatch for NEW requests?", [
        ...(defaults?.delayed_work ? [{ value: "keep", label: "Keep the reviewed delayed-work limits", detail: "Recheck the exact saved bounds; this does not renew old requests." }] : []),
        { value: "no", label: "No — retain short proof lifetime", detail: "Current requests and previously saved work keep their existing expiration behavior." },
        { value: "yes", label: "Yes — reverify the exact operation", detail: "Set finite request-anchored approval, mandate and absolute deadlines; Runner checks current facts again before an effect." },
      ], { initialValue: defaults?.delayed_work ? "keep" : "no", displayContext: true, context: [`Outcome: ${input.outcome}. This choice is part of separately reviewed execution policy, not a change to the Action fact-proof TTL.`,
        ...(defaults?.delayed_work ? [`Saved bounds: wait ${defaults.delayed_work.approval_wait_seconds}s, approval ${defaults.delayed_work.approval_validity_seconds}s, absolute ${defaults.delayed_work.absolute_request_age_seconds}s, checks ${defaults.delayed_work.max_validation_attempts}.`] : [])] });
      if (!delayedChoice) return undefined;
      if (delayedChoice === "no") delayedWork = undefined;
      if (delayedChoice === "yes") {
        const boundedSeconds = async (label: string, maximum = 2_592_000): Promise<number | undefined> => {
          const answer = await input.session.promptText(`${label} (seconds; 60–${maximum})`, {
            context: ["Enter an explicit finite value. The original request time never moves; Enter or cancel leaves execution unchanged."],
          });
          if (answer === undefined) return undefined;
          const value = Number(answer.trim());
          if (!Number.isSafeInteger(value) || value < 60 || value > maximum) {
            throw new Error(`DELAYED_WORK_BOUND_INVALID: ${label} must be a finite integer from 60 through ${maximum}.`);
          }
          return value;
        };
        const approvalWait = await boundedSeconds("Approval waiting limit");
        if (approvalWait === undefined) return undefined;
        const approvalValidity = await boundedSeconds("Approval validity after the decision");
        if (approvalValidity === undefined) return undefined;
        const absoluteAge = await boundedSeconds("Absolute age of the original request");
        if (absoluteAge === undefined) return undefined;
        const attemptsText = await input.session.promptText("Maximum fresh-validation attempts (2–20)", {
          context: ["This caps fact checks separately from approvals and worker execution attempts."],
        });
        if (attemptsText === undefined) return undefined;
        const attempts = Number(attemptsText.trim());
        if (!Number.isSafeInteger(attempts) || attempts < 2 || attempts > 20 || approvalWait > absoluteAge) {
          throw new Error("DELAYED_WORK_BOUND_INVALID: enter 2–20 attempts and an approval wait no longer than absolute request age.");
        }
        delayedWork = { mode: "reverify_exact_operation", approval_wait_seconds: approvalWait,
          approval_validity_seconds: approvalValidity, absolute_request_age_seconds: absoluteAge,
          max_validation_attempts: attempts };
      }
    }
      // The choice is a reviewed change to the exact execution candidate.
      // Recompute the preview, posture and confirmation whenever it differs
      // from the initial saved default; no prior inspection is authorization.
      if (JSON.stringify(delayedWork ?? null) !== JSON.stringify(defaults?.delayed_work ?? null)) {
        preview = await previewSemanticSupervisedExecution({
          projectRoot: input.projectRoot, outcome: input.outcome, profile, writeUrlEnv,
          ...(delayedWork ? { delayedWork } : {}),
          ...(workerIdentity === undefined ? {} : { workerIdentity }),
          ...(input.env ? { env: input.env } : {}),
          ...(input.inspectDatabaseFn ? { inspect: input.inspectDatabaseFn } : {}),
        });
        await verifySemanticExecutionReadPosture({ projectRoot: input.projectRoot, outcome: input.outcome,
          activeReads: input.activeReads, env: input.env, inspect: input.inspectDatabaseFn });
      }
    }
  } catch (error) {
    const problem = executionSetupProblem(error);
    return { tone: "danger", title: problem.publication_state ? "Execution save needs recovery." : "Execution was not enabled.", lines: [problem.summary], problem,
      ...(error instanceof SemanticWriterPostureError && error.provisioning ? { provisioning: error.provisioning } : {}) };
  }
  const launchPreview = await assessWorkerLaunch({ config: preview.config as RuntimeConfig,
    configPath: path.resolve(input.projectRoot, preview.config_path), capability: input.outcome, env: input.env });
  // This is the proposed launch configuration, still awaiting the separate enable decision.
  launchPreview.execution_enabled = false;
  const findings = semanticExecutionVerificationLines(preview);
  input.session.rememberDetails?.("Write connection verification", findings);
  const confirmed = await (input.session.confirmActivation ?? input.session.confirm)(
    `Enable supervised source execution for ${input.outcome}?`,
    {
      context: [
        ...findings,
        ...workerLaunchLines(launchPreview),
        `Writer role: ${preview.writer_role}; worker: ${workerIdentity ?? "not pinned"}.`,
        `Receipts: ${preview.receipts.authority === "source_db" ? `source_db, ${preview.receipts.schema}.${preview.receipts.table}` : "runner_ledger"}.`,
        `Worker bounds: concurrency ${preview.policy.concurrency}; queue ${preview.policy.queue_limit}; attempts ${preview.policy.max_attempts}; rate ${preview.policy.rate_limit.executions}/${preview.policy.rate_limit.window_seconds}s.`,
        ...(preview.policy.delayed_work ? [
          `Delayed new requests: approval wait ${preview.policy.delayed_work.approval_wait_seconds}s; approval validity ${preview.policy.delayed_work.approval_validity_seconds}s; absolute age ${preview.policy.delayed_work.absolute_request_age_seconds}s; fresh validations at most ${preview.policy.delayed_work.max_validation_attempts}.`,
          `Worker proposal age ${preview.policy.proposal_ttl_seconds}s is retained when previously reviewed; absolute request age ${preview.policy.delayed_work.absolute_request_age_seconds}s cannot exceed it. The earlier deadline wins. Source proof TTL is unchanged.`,
        ] : []),
        "Enables an operator-run worker for approved proposals. No proposal executes here.",
        "Model approval, apply and patch selection remain unavailable.",
      ],
    },
  );
  if (!confirmed) return undefined;
  try {
    const enabled = await enableSemanticSupervisedExecution({
      projectRoot: input.projectRoot,
      outcome: input.outcome,
      profile,
      writeUrlEnv,
      ...(delayedWork ? { delayedWork } : {}),
      ...(workerIdentity === undefined ? {} : { workerIdentity }),
      expectedActionBoundaryDigest: preview.action_boundary_digest,
      expectedConfigDigest: preview.current_config_digest,
      expectedWriterPostureFingerprint: preview.writer_posture_fingerprint,
      confirmation: semanticExecutionConfirmation(preview),
      ...(input.env ? { env: input.env } : {}),
      ...(input.inspectDatabaseFn ? { inspect: input.inspectDatabaseFn } : {}),
    });
    await clearPausedExecutionSetup(input.projectRoot, input.active.authority.action_boundary.digest, input.outcome).catch(() => {
      input.session.rememberDetails?.("Execution setup diagnostics", ["Execution was enabled, but the previous diagnostic checkpoint could not be removed. It does not grant or revoke authority."]);
    });
    const configPath = path.resolve(input.projectRoot, enabled.config_path);
    const launch = await assessWorkerLaunch({ config: enabled.config as RuntimeConfig, configPath, capability: enabled.outcome, env: input.env });
    return {
      tone: "success",
      title: "Supervised execution enabled for this outcome.",
      lines: [
        `${enabled.outcome}: approved proposals may be leased by semantic_action_worker.`,
        ...workerLaunchLines(launch),
        "Transaction-time fact reload, rule evaluation, effect comparison, scope, conflict, rate, and receipt checks remain mandatory.",
        "No proposal was executed and source data is unchanged.",
      ],
    };
  } catch (error) {
    const problem = executionSetupProblem(error);
    return { tone: "danger", title: problem.publication_state ? "Execution save needs recovery." : "Execution was not enabled.", lines: [problem.summary], problem };
  }
}

function semanticExecutionProfile(
  active: ActionRuleAuthorityActivationV1,
  activeReads: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>>,
  outcome: string,
): "development" | "staging" | "production" {
  const rank = { development: 0, staging: 1, production: 2 } as const;
  const profiles = active.authority.rules.filter((rule) => rule.rule.outcome === outcome).map((rule) => {
    const boundary = activeReads.find((candidate) =>
      candidate.pack.name === rule.read_boundary_name
      && candidate.activation.digest === rule.read_boundary_digest);
    if (!boundary) {
      throw new Error(`ACTION_RULE_READ_AUTHORITY_STALE: ${rule.read_boundary_name} is not active at the reviewed digest.`);
    }
    return boundary.deployment_profile;
  });
  return profiles.reduce((strictest, profile) => rank[profile] > rank[strictest] ? profile : strictest, "development");
}

function verifiedActionAuthoritySummary(
  value: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1,
  stateLabel: string,
  enabledExecutionOutcomes: Set<string> = new Set(),
  terminalColumns = 100,
  unavailableOutcomes: Set<string> = new Set(),
): string[] {
  const rows = value.authority.action_boundary.rules.map((rule) => [
    rule.outcome,
    actionRuleEffectInventory(value.authority.rules.find(r => r.rule.outcome === rule.outcome)!).components
      .map(c => `${c.operation.toUpperCase()} ${c.resource} (max ${c.max_rows})`).join("; "),
    rule.approval_mode === "policy" ? "Policy + fallback" : "Human review",
    unavailableOutcomes.has(rule.outcome)
      ? enabledExecutionOutcomes.has(rule.outcome) ? "Enabled, blocked" : "Unavailable"
      : rule.writeback.mode === "none"
      ? "Proposal only"
      : enabledExecutionOutcomes.has(rule.outcome)
        ? "Execution enabled"
        : "Eligible, off",
  ]);
  const tableWidth = reviewTableWidth(terminalColumns);
  const table = tableWidth >= 84
    ? renderBoundaryMapTable(
        ["Outcome", "Derived effect", "Approval", "Apply"],
        rows,
        { widths: fourColumnReviewWidths(tableWidth), rowSeparators: false },
      )
    : renderBoundaryMapTable(
        ["Decision", "Reviewed value"],
        rows.flatMap((row) => [
          ["Outcome", row[0]!],
          ["Derived effect", row[1]!],
          ["Approval", row[2]!],
          ["Apply", row[3]!],
        ]),
        { widths: twoColumnReviewWidths(tableWidth), rowSeparators: false },
      );
  return [
    `${stateLabel}  ${value.authority.action_boundary.name}`,
    ...table,
  ];
}

function verifiedActionNotice(
  value: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1,
  active: boolean,
  configPath?: string,
): BoundaryAccessNotice {
  const count = value.authority.action_boundary.rules.length;
  return {
    tone: active ? "success" : "warning",
    title: active ? "Verified Action Boundary active." : "Verified Action Boundary kept disabled.",
    lines: [
      `${value.authority.action_boundary.name}: ${count} verified ${count === 1 ? "outcome" : "outcomes"}.`,
      active
        ? "Agents may nominate an outcome and opaque subjects; Runner verifies and derives the exact proposal."
        : "No agent proposal authority changed.",
      ...(active && configPath ? [`Action MCP config: ${configPath}`] : []),
      "Approval and apply remain separate. Source database changed: no.",
    ],
  };
}

export function verifiedActionAuthoritySections(
  draft: ActionRuleAuthorityDraftV1,
  terminalColumns = 100,
): import("./read-boundary-review-view.js").ReviewSection[] {
  return [
    { id: "outcomes", title: "All reviewed outcomes", lines: [
      ...verifiedActionAuthoritySummary(draft, "PENDING PROPOSAL AUTHORITY", new Set(), terminalColumns),
      "Every retained and added outcome in this revision is listed. Execution is a separate review.",
      `Action Boundary digest: ${draft.authority.action_boundary.digest}`,
    ] },
    { id: "authority", title: "Complete authority and fingerprints", lines: verifiedActionAuthorityDetails(draft, terminalColumns) },
  ];
}

export function verifiedActionAuthorityDetails(
  value: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1,
  terminalColumns = 100,
): string[] {
  const byOutcome = new Map(value.reviews.map((review) => [review.outcome, review]));
  const lines: string[] = [];
  for (const rule of value.authority.action_boundary.rules) {
    const review = byOutcome.get(rule.outcome);
    const source = value.authority.rules.find((candidate) => candidate.rule.outcome === rule.outcome);
    const approval = value.authority.approval_classes.find((candidate) => candidate.name === rule.approval_class);
    const discovery = source?.rule["x-runner-discovery"] === undefined ? undefined : actionRuleDiscoveryMetadata(source.rule);
    lines.push(
      `OUTCOME  ${rule.outcome}`,
      ...(discovery ? [
        `CLIENT   ${discovery.title}`,
        `SUMMARY  ${discovery.summary}`,
        `SEARCH   ${discovery.aliases.join(", ") || "No additional search phrases"}`,
      ] : []),
      `WHEN     ${review?.when ?? "See canonical rule below."}`,
      `THEN     ${review?.then ?? `${rule.operation.toUpperCase()} ${rule.target_resource}`}`,
      ...actionRuleEffectLines(source!),
      `REFUSE   ${review ? joinReviewClauses(review.refused) : "Any failed or unknown eligibility check"}`,
      `REVIEW   ${humanApprovalRequirement(approval)}`,
      `APPLY    ${rule.writeback.mode === "none" ? "Proposal only; no source write" : "Separately supervised; never model authority"}`,
      `PRIVATE  ${source?.verification_boundary.resources.map((resource) =>
        `${resource.binding}: ${resource.fields.filter((field) => !field.model_visible).map((field) => field.name).join(", ") || "none"}`).join("; ") ?? "unavailable"}`,
      ...(review?.examples.length
        ? [
            "EXAMPLES",
            ...renderBoundaryMapTable(
              ["Case", "Scenario", "Result"],
              review.examples.map((example) => [example.kind, example.scenario, example.result]),
              {
                widths: threeColumnReviewWidths(reviewTableWidth(terminalColumns)),
                rowSeparators: false,
              },
            ),
          ]
        : []),
      `Rule digest: ${rule.action_rule_digest}`,
      `Compiled plan digest: ${rule.compiled_plan_digest}`,
      `Action Boundary digest: ${value.authority.action_boundary.digest}`,
      "",
    );
  }
  lines.push(
    "EXACT AUTHORITY (OPERATOR ONLY)",
    `Authority digest: ${value.digest}`,
    "The complete reviewed predicates, effects, private verification, approval limits and dependencies follow.",
    "```json",
    ...JSON.stringify(value.authority, null, 2).split("\n"),
    "```",
  );
  return lines;
}

function joinReviewClauses(clauses: readonly string[]): string {
  return clauses
    .map((clause) => clause.trim().replace(/[.!?;:,]+$/u, ""))
    .filter(Boolean)
    .map((clause) => `${clause}.`)
    .join(" ");
}

function humanApprovalRequirement(approval: {
  required_approvals: number;
  required_role: string;
} | undefined): string {
  const count = approval?.required_approvals ?? 1;
  const role = approval?.required_role ?? "reviewer";
  return `${count} distinct ${role} ${count === 1 ? "approval" : "approvals"}`;
}

function reviewTableWidth(terminalColumns: number | undefined): number {
  return Math.max(44, (terminalColumns ?? 100) - 4);
}

function twoColumnReviewWidths(tableWidth: number): [number, number] {
  const contentWidth = tableWidth - 7;
  const labelWidth = Math.min(18, Math.max(12, Math.floor(contentWidth * 0.28)));
  return [labelWidth, contentWidth - labelWidth];
}

function threeColumnReviewWidths(tableWidth: number): [number, number, number] {
  const contentWidth = tableWidth - 10;
  const caseWidth = Math.min(12, Math.max(8, Math.floor(contentWidth * 0.16)));
  const remaining = contentWidth - caseWidth;
  const scenarioWidth = Math.max(12, Math.floor(remaining * 0.48));
  return [caseWidth, scenarioWidth, remaining - scenarioWidth];
}

function fourColumnReviewWidths(tableWidth: number): [number, number, number, number] {
  const contentWidth = tableWidth - 13;
  const outcomeWidth = Math.max(16, Math.floor(contentWidth * 0.28));
  const effectWidth = Math.max(17, Math.floor(contentWidth * 0.29));
  const approvalWidth = Math.max(14, Math.floor(contentWidth * 0.24));
  return [
    outcomeWidth,
    effectWidth,
    approvalWidth,
    contentWidth - outcomeWidth - effectWidth - approvalWidth,
  ];
}

function localInteractiveActor(): string {
  const value = process.env.SYNAPSOR_OPERATOR_ID?.trim()
    || process.env.USER?.trim()
    || "local-developer";
  if (value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value)) return value;
  return "local-developer";
}

/** Findings from this actual verifier invocation, not a saved selection or a test. */
export function semanticExecutionVerificationLines(preview: Awaited<ReturnType<typeof previewSemanticSupervisedExecution>>): string[] {
  const writer = preview.verification.writer;
  return [
    `Writer verification: ${writer.ok ? "PASSED" : "FAILED"} — source ${preview.source}.`,
    `Checked reference: ${preview.write_url_env}.`,
    `Permissions/scope: ${writer.ok ? "PASSED" : "unresolved"}; ${writer.required_relations?.length ?? writer.allowed_relations.length} relations for effects, locks and receipts.`,
    ...(!writer.ok ? [`Blockers: ${writer.reasons.join(", ")}`] : ["Remaining verification blockers: none in this check."]),
    preview.verification.receipt_probe === "passed_rolled_back" ? "Receipt probe: PASSED, rolled back; no business execution or persisted receipt."
      : "Receipt probe: NOT RUN (Runner-ledger mode); no source-atomic receipt guarantee.",
    `Current candidate: ${preview.outcome}.`,
    "Exact Action/config/writer bindings checked again on confirmation.",
    "Read posture rechecked. Worker liveness, business execution and independent readback: NOT RUN.",
  ];
}

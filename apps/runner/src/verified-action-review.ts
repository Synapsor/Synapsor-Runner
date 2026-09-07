import process from "node:process";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
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
import { clearPausedExecutionSetup, executionSetupProblem, savePausedExecutionSetup, type ExecutionSetupProblem } from "./semantic-execution-setup.js";
import {
  activateSemanticActionRuntime,
  disableSemanticSupervisedExecution,
  enableSemanticSupervisedExecution,
  previewSemanticSupervisedExecution,
  readSemanticSupervisedExecutionState,
  semanticExecutionConfirmation,
} from "./semantic-action-deployment.js";

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
}): Promise<BoundaryAccessNotice> {
  const activeReads = await loadActivatedExplorationBoundaries(input.projectRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const draftReady = input.draft?.authority.rules.every((rule) => activeReads.some((boundary) =>
    boundary.pack.name === rule.read_boundary_name
    && boundary.activation.digest === rule.read_boundary_digest)) ?? false;
  const current = input.draft ?? input.active;
  if (!current) {
    return {
      tone: "warning",
      title: "No verified Action outcome is prepared.",
      lines: ["Use W and describe a job whose exact effect must be derived from current authoritative facts."],
      footer: "Caller-supplied proposal actions remain available through Y.",
    };
  }
  let executionState = await readSemanticSupervisedExecutionState({
    projectRoot: input.projectRoot,
  });
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
        "ACTIVE AUTHORITY",
        enabledExecutionOutcomes(),
        input.session.terminalColumns,
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
  const summary = [
    ...activeSummary,
    ...(activeSummary.length && draftSummary.length ? [""] : []),
    ...draftSummary,
    "The agent supplies an outcome and opaque subject reference only. Runner reloads facts and derives the effect.",
    input.draft
      ? draftReady
        ? input.active
          ? "The active authority remains live until you separately confirm this exact replacement."
          : "Disabled revision is ready for its separate proposal-authority confirmation."
        : input.active
          ? `The active authority remains live. Activate the exact linked Read Boundary ${input.boundaryName} before reviewing its replacement.`
          : `Activate the exact linked Read Boundary ${input.boundaryName} before this Action revision.`
      : "This verified Action Boundary is active. Approval and apply remain separate.",
  ];
  if (!input.session.chooseOption) {
    if (!input.draft || !draftReady) {
      return {
        tone: input.active && !input.draft ? "success" : "warning",
        title: input.active && input.draft
          ? "Active verified authority is unchanged; its replacement is not ready."
          : input.active
            ? "Verified Action Boundary is active."
            : "Verified Action Boundary is not ready to activate.",
        lines: summary,
      };
    }
    const accepted = await (input.session.confirmActivation ?? input.session.confirm)(
      `Activate verified Action Boundary "${input.draft.authority.action_boundary.name}"?`,
      { context: summary },
    );
    if (!accepted) return verifiedActionNotice(input.draft, false);
    const activated = await activateSemanticActionRuntime({
      projectRoot: input.projectRoot,
      ...(input.baseConfigPath ? { baseConfigPath: input.baseConfigPath } : {}),
      draft: input.draft,
      actor: localInteractiveActor(),
    });
    return verifiedActionNotice(activated.activation, true, activated.config_path);
  }
  while (true) {
    const choice = await input.session.chooseOption(
      "VERIFIED ACTION BOUNDARY",
      [
        ...(input.draft
          ? [{
              value: "activate",
              label: draftReady ? "Activate this exact proposal authority" : "Activate linked Read Boundary first",
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
              label: "View active authority details",
              detail: "Shows the exact rules currently available to agents.",
            }]
          : []),
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
        initialValue: input.draft && draftReady
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
        tone: input.active && !input.draft ? "success" : "warning",
        title: input.active && input.draft
          ? "Active verified authority is unchanged; replacement remains disabled."
          : input.active
            ? "Verified Action Boundary remains active."
            : "Verified Action Boundary remains disabled.",
        lines: [
          ...(input.active && input.draft
            ? ["The active and replacement revisions remain separate."]
            : []),
          "No authority or source data changed.",
        ],
      };
    }
    if (choice === "details_draft" && input.draft) {
      await input.session.chooseOption(
        input.active ? "EXACT REPLACEMENT DRAFT DETAILS" : "EXACT VERIFIED ACTION DETAILS",
        [{ value: "back", label: "Back to Action Boundary" }],
        {
          initialValue: "back",
          context: verifiedActionAuthorityDetails(input.draft, input.session.terminalColumns),
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
    if (choice === "model_revision" && input.modelRevision) {
      return input.modelRevision.run();
    }
    if (choice.startsWith("enable_execution:") && input.active) {
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
      executionState = await readSemanticSupervisedExecutionState({ projectRoot: input.projectRoot });
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
      });
      return verifiedActionNotice(activated.activation, true, activated.config_path);
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
    input.session.rememberDetails?.("Writer requirements", problem.details);
    const recovery = await input.session.chooseOption("Execution needs a deployment fix", [
      { value: "retry", label: "Recheck the writer and continue setup", detail: "Correct the grants externally, or choose another configured credential. This does not execute a request." },
      { value: "details", label: "Inspect the exact writer requirements" },
      { value: "pause", label: "Save and pause execution setup", detail: "Read and proposal authority stay active; automatic completion stays off." },
    ], { initialValue: "pause", context: [problem.summary, `Diagnostic: ${problem.code}. Inspect requirements for the exact administrator handoff.`] });
    if (recovery === "retry") continue;
    if (recovery === "details") {
      await input.session.showReviewDetails?.("Writer requirements", problem.details);
      // Inspection does not repeat the provider/role request or discard the pending failure.
      const next = await input.session.chooseOption("Continue execution setup", [
        { value: "retry", label: "Recheck the writer" },
        { value: "pause", label: "Save and pause execution setup" },
      ], { initialValue: "pause" });
      if (next === "retry") continue;
    }
    await savePausedExecutionSetup(input.projectRoot, { action_digest: input.active.authority.action_boundary.digest,
      outcome: input.outcome, problem });
    return { tone: "success", title: "Execution setup paused.",
      lines: ["Read and reviewed change requests remain available; automatic database updates are off."],
      footer: "Resume execution setup with the same start command after repairing the write connection. Saved writer requirements remain available." };
  }
}

async function reviewSemanticSupervisedExecutionAttempt(input: Parameters<typeof reviewSemanticSupervisedExecution>[0]): Promise<(BoundaryAccessNotice & { problem?: ExecutionSetupProblem }) | undefined> {
  const env = input.env ?? process.env;
  let writeUrlEnv = "SYNAPSOR_DATABASE_WRITE_URL";
  let configured = Boolean(env[writeUrlEnv]?.trim());
  if (configured && input.session.chooseOption) {
    const choice = await input.session.chooseOption("Check your write connection", [
      { value: "check", label: "Check the configured write connection", detail: "Verify its permissions; do not enable execution or run a request." },
      { value: "change", label: "Use another configured connection" },
      { value: "pause", label: "Set up execution later" },
    ], { initialValue: "check", context: [`Connection: ${writeUrlEnv} is set (value hidden). Execution authorization comes after verification.`] });
    if (!choice || choice === "pause") return undefined;
    configured = choice === "check";
  } else configured = false;
  if (!configured) {
    const writeUrlAnswer = await input.session.promptText(
    "Write connection variable (Enter uses SYNAPSOR_DATABASE_WRITE_URL)",
    {
      context: [
        "Your read-only connection cannot execute changes. Configure a separate write connection, then enter its variable name here, not its URL.",
        "This checks permissions only. Enabling execution and starting a worker are separate decisions.",
      ],
    },
  );
  if (writeUrlAnswer === undefined) return undefined;
    writeUrlEnv = writeUrlAnswer.trim() || writeUrlEnv;
  }
  const profile = semanticExecutionProfile(input.active, input.activeReads);
  let preview: Awaited<ReturnType<typeof previewSemanticSupervisedExecution>>;
  try {
    preview = await previewSemanticSupervisedExecution({
      projectRoot: input.projectRoot,
      outcome: input.outcome,
      profile,
      writeUrlEnv,
      workerIdentity: "semantic_action_worker",
      ...(input.env ? { env: input.env } : {}),
      ...(input.inspectDatabaseFn ? { inspect: input.inspectDatabaseFn } : {}),
    });
  } catch (error) {
    const problem = executionSetupProblem(error);
    return { tone: "danger", title: "Execution was not enabled.", lines: [problem.summary], problem };
  }
  const confirmed = await (input.session.confirmActivation ?? input.session.confirm)(
    `Enable supervised source execution for ${input.outcome}?`,
    {
      context: [
        ...renderBoundaryMapTable(
          ["Authority", "Reviewed value"],
          [
            ["Outcome", preview.outcome],
            ["Effect", `${preview.operation.toUpperCase()} ${preview.target}`],
            ["Writer role", preview.writer_role],
            ["Credential reference", preview.write_url_env],
            ["Receipts", "Runner ledger"],
            ["Concurrency", String(preview.policy.concurrency)],
            ["Queue / retries", `${preview.policy.queue_limit} / ${preview.policy.max_attempts}`],
            ["Rate", `${preview.policy.rate_limit.executions} per ${preview.policy.rate_limit.window_seconds}s`],
          ],
          { widths: twoColumnReviewWidths(reviewTableWidth(input.session.terminalColumns ?? 80)), rowSeparators: false },
        ),
        "This enables an operator-run worker for approved proposals only. The model still cannot approve, apply, or choose a patch.",
        "No proposal is executed during this confirmation.",
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
      workerIdentity: "semantic_action_worker",
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
    return {
      tone: "success",
      title: "Supervised execution enabled for this outcome.",
      lines: [
        `${enabled.outcome}: approved proposals may be leased by semantic_action_worker.`,
        `Run: ${cliCommandName()} worker run --supervised --yes --config ${shellQuote(enabled.config_path)}`,
        "Transaction-time fact reload, rule evaluation, effect comparison, scope, conflict, rate, and receipt checks remain mandatory.",
        "No proposal was executed and source data is unchanged.",
      ],
    };
  } catch (error) {
    const problem = executionSetupProblem(error);
    return { tone: "danger", title: "Execution was not enabled.", lines: [problem.summary], problem };
  }
}

function semanticExecutionProfile(
  active: ActionRuleAuthorityActivationV1,
  activeReads: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>>,
): "development" | "staging" | "production" {
  const rank = { development: 0, staging: 1, production: 2 } as const;
  const profiles = active.authority.rules.map((rule) => {
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
): string[] {
  const rows = value.authority.action_boundary.rules.map((rule) => [
    rule.outcome,
    `${rule.operation.toUpperCase()} ${rule.target_resource}`,
    rule.approval_mode === "policy" ? "Policy + fallback" : "Human review",
    rule.writeback.mode === "none"
      ? "Proposal only"
      : enabledExecutionOutcomes.has(rule.outcome)
        ? "Worker on"
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

function verifiedActionAuthorityDetails(
  value: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1,
  terminalColumns = 100,
): string[] {
  const byOutcome = new Map(value.reviews.map((review) => [review.outcome, review]));
  const lines: string[] = [];
  for (const rule of value.authority.action_boundary.rules) {
    const review = byOutcome.get(rule.outcome);
    const source = value.authority.rules.find((candidate) => candidate.rule.outcome === rule.outcome);
    const approval = value.authority.approval_classes.find((candidate) => candidate.name === rule.approval_class);
    lines.push(
      `OUTCOME  ${rule.outcome}`,
      `WHEN     ${review?.when ?? "See canonical rule below."}`,
      `THEN     ${review?.then ?? `${rule.operation.toUpperCase()} ${rule.target_resource}`}`,
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

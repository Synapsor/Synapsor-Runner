import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { hasReviewedPrincipalScope } from "./auto-boundary.js";
import { AskError } from "./model-ask.js";
import type { ActionModelSuggestionSession } from "./action-tui.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { formatDerivedScopePath } from "./derived-scope-display.js";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { interpretPrincipalScopeAnswer, type ModelPrincipalScopeOption } from "./model-principal-scope-review.js";
import { inspectBoundaryResourceReview, prepareBoundaryReviewMutationBatch, commitBoundaryReviewMutationBatch,
  type BoundaryResourceReviewView, type BoundaryResourceReviewRequest } from "./boundary-review-mutation.js";

/** The structural scope owner receives typed business requirements, never
 * derives them from job prose. Its existing protected mutation writer retains
 * ownership of preview/currentness/commit; this host supplies no authority. */
type ReviewedJobPrincipalScope =
  | { kind: "direct"; value: string; label: string; confidence: "low" | "medium" | "high" }
  | { kind: "derived"; value: string; label: string; confidence: "catalog_proven" }
  | { kind: "postgres_rls"; value: string; label: string; confidence: "review_required" };

function reviewedJobPrincipalScopeOptions(
  view: BoundaryResourceReviewView,
): ReviewedJobPrincipalScope[] {
  const fields = new Map(view.fields.map((field) => [field.name, field]));
  const direct = [...new Set(view.principal_key.candidates)]
    .filter((field) => fields.get(field)?.nullable === false)
    .map((field): ReviewedJobPrincipalScope => {
      const confidence = view.principal_key.alternatives_considered
        .find((candidate) => candidate.value === field)?.confidence ?? "low";
      return {
        kind: "direct",
        value: field,
        label: `column ${field} [${confidence}-confidence candidate]`,
        confidence,
      };
    });
  const derived = (view.derived_principal_scope?.candidates ?? []).map(
    (scope): ReviewedJobPrincipalScope => ({
      kind: "derived",
      value: scope.path_id,
      label: `catalog-proven mandatory path ${formatDerivedScopePath(scope)}`,
      confidence: "catalog_proven",
    }),
  );
  const postgresRls = (view.rls?.principal_setting_candidates ?? [])
    .filter((setting) => setting !== view.candidate?.rls_session?.tenant_setting)
    .map((setting): ReviewedJobPrincipalScope => ({
      kind: "postgres_rls",
      value: setting,
      label: `PostgreSQL RLS setting ${setting} [meaning requires review]`,
      confidence: "review_required",
    }));
  return [...direct, ...derived, ...postgresRls];
}

function briefPrincipalScopeLabel(scope: ReviewedJobPrincipalScope): string {
  if (scope.kind === "direct") return `${scope.value} (${scope.confidence} confidence)`;
  if (scope.kind === "postgres_rls") return `${scope.value} (PostgreSQL RLS)`;
  return `${scope.value} (catalog proven)`;
}

function hasReviewedJobPrincipalScope(view: BoundaryResourceReviewView): boolean {
  return Boolean(view.candidate && hasReviewedPrincipalScope(view.candidate));
}

function exactReviewedPrincipalScopeAnswer(
  answer: string,
  options: ReviewedJobPrincipalScope[],
): ReviewedJobPrincipalScope | undefined {
  const normalized = answer.trim().replace(/[.)]+$/u, "").trim().toLowerCase();
  const numbered = /^(?:candidate\s+)?(\d+)$/u.exec(normalized);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    return Number.isSafeInteger(index) ? options[index] : undefined;
  }
  const matches = options.filter((option) => {
    const value = option.value.toLowerCase();
    return normalized === value
      || normalized === option.label.toLowerCase()
      || normalized === `column ${value}`
      || normalized === `path ${value}`;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function reviewJobPrincipalScopeWithModel(input: {
  resourceId: string;
  options: ReviewedJobPrincipalScope[];
  jobIntent: string;
  session: BoundaryReviewInteractiveSession;
  modelSession: ActionModelSuggestionSession;
  narrator: typeof narrateValidatedAuthoringStep;
  interpreter?: typeof interpretPrincipalScopeAnswer;
  authoringChat: BoundaryAuthoringChat;
}): Promise<{ handled: true; scope?: ReviewedJobPrincipalScope } | { handled: false }> {
  const candidateFacts = input.options.map((option, index) =>
    `Candidate ${index + 1}: ${option.label}`);
  const nextQuestion = input.options.length === 1
    ? input.options[0]!.kind === "postgres_rls"
      ? `Does ${input.options[0]!.value} carry the authenticated person's trusted identity for ${input.resourceId}?`
      : `Does ${input.options[0]!.label} identify the authenticated person who owns rows in ${input.resourceId}?`
    : [
        `Which candidate identifies the authenticated person who owns rows in ${input.resourceId}?`,
        ...candidateFacts,
        "Answer with the candidate number or exact reviewed name, or say none.",
      ].join("\n");
  const opening = await input.authoringChat.progress(
    `${`${input.modelSession.provider}[${input.modelSession.model}]`} is reviewing trusted user scope`,
    () => input.narrator({
      session: input.modelSession,
      operatorMessage: `Clarify the business meaning of the reviewed principal-scope candidates for ${input.resourceId}.`,
      validatedFacts: [
        `Own-row isolation is required by this job: ${input.jobIntent}`,
        ...candidateFacts,
        "These are exact live-catalog candidates, not authority.",
        "Runner will require an exact confirmation before changing the disabled draft.",
      ],
      nextQuestion,
      egressAcknowledged: true,
    }),
  );
  if (!opening) return { handled: false };

  const modelOptions: ModelPrincipalScopeOption[] = input.options.map((option, index) => ({
    id: `candidate_${index + 1}`,
    kind: option.kind,
    value: option.value,
    label: option.label,
  }));
  let question = opening;
  for (let clarification = 0; clarification < 2; clarification += 1) {
    const answer = await input.session.promptText(question, {
      context: [
        "MODEL QUESTION - TRUSTED USER/OWNER SCOPE",
        ...candidateFacts,
        "Answer in ordinary language. The model translates; Runner validates the exact choice.",
      ],
    });
    if (answer === undefined) return { handled: true };
    const exactSelection = exactReviewedPrincipalScopeAnswer(answer, input.options);
    let selected = exactSelection;
    let rationale = exactSelection
      ? `The operator selected Candidate ${input.options.indexOf(exactSelection) + 1} exactly.`
      : undefined;
    if (!selected) {
      const resolution = await input.authoringChat.progress(
        `${`${input.modelSession.provider}[${input.modelSession.model}]`} is interpreting the scope answer`,
        () => (input.interpreter ?? interpretPrincipalScopeAnswer)({
          session: input.modelSession,
          resourceId: input.resourceId,
          options: modelOptions,
          answer,
          egressAcknowledged: true,
        }),
      );
      if (resolution.state === "none") {
        input.authoringChat.rememberDetails("TRUSTED USER/OWNER SCOPE NOT SELECTED", [
          `Resource: ${input.resourceId}`,
          ...(resolution.rationale ? [`Model interpretation: ${resolution.rationale}`] : []),
          "No reviewed principal predicate was recorded.",
          "Agent authority changed: no",
          "Source database changed: no",
        ]);
        return { handled: true };
      }
      if (resolution.state === "clarification") {
        question = resolution.question;
        continue;
      }
      const selectedIndex = modelOptions.findIndex((option) => option.id === resolution.option_id);
      selected = input.options[selectedIndex];
      rationale = resolution.rationale;
      if (!selected) return { handled: false };
    }
    const summary = await input.authoringChat.progress(
      `${`${input.modelSession.provider}[${input.modelSession.model}]`} is summarizing the exact scope choice`,
      () => input.narrator({
        session: input.modelSession,
        operatorMessage: answer,
        validatedFacts: [
          `Runner resolved one exact candidate for ${input.resourceId}: ${selected.label}.`,
          ...(rationale ? [`Resolution: ${rationale}`] : []),
          "The value will come only from trusted Runner context, never model arguments.",
          "Recording it changes only the disabled draft; Read and Action authority remain off.",
        ],
        nextQuestion: "Should Runner record this exact trusted user/owner predicate in the disabled Boundary?",
        egressAcknowledged: true,
      }),
    );
    if (summary) await input.authoringChat.streamModel(summary.split(/\r?\n/u));
    const accepted = await input.session.confirm(
      `Record ${selected.label} as the exact trusted user/owner predicate for ${input.resourceId}?`,
      {
        defaultValue: false,
        context: [
          "REVIEW EXACT USER/OWNER SCOPE",
          `Resource: ${input.resourceId}`,
          `Exact predicate: ${selected.label}`,
          "Confirm only when trusted authenticated-principal context has this exact business meaning.",
          "This changes a disabled draft only. Agent authority and source data remain unchanged.",
        ],
      },
    );
    return accepted ? { handled: true, scope: selected } : { handled: true };
  }
  return { handled: true };
}

export async function reviewRequiredPrincipalScopes(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  jobIntent: string;
  resourceIds: Iterable<string>;
  actor(): string;
  resolveRequirement(resources: readonly string[]): Promise<{ required: string[]; unresolved: string[] }>;
  /** Report the real protected structural save, including before bindings.
   * This is not final business/proof confirmation and cannot invent a model response. */
  /** Persist the exact pending preview association before any structural write.
   * This grants no proof; a rejected/uncertain save prevents the write. */
  onPrepared?(preview: Awaited<ReturnType<typeof prepareBoundaryReviewMutationBatch>>): Promise<void>;
  onCommitted?(result: { preview: Awaited<ReturnType<typeof prepareBoundaryReviewMutationBatch>>;
    committed: Awaited<ReturnType<typeof commitBoundaryReviewMutationBatch>> }): Promise<void>;
  modelSession?: ActionModelSuggestionSession;
  modelNarrator?: typeof narrateValidatedAuthoringStep;
  modelInterpreter?: typeof interpretPrincipalScopeAnswer;
  authoringChat?: BoundaryAuthoringChat;
}): Promise<{ state: "ready"; changed: boolean } | { state: "paused"; resources: string[] }> {
  const assertRunning = () => {
    if (input.authoringChat?.signal?.aborted || input.modelSession?.dependencies?.signal?.aborted) {
      throw new AskError("ASK_CANCELLED", "Boundary conversation paused.", 499);
    }
  };
  assertRunning();
  const requested = [...new Set(input.resourceIds)].sort();
  const requirement = await input.resolveRequirement(requested);
  if (requirement.unresolved.length) {
    input.session.present?.("SUBJECT SCOPE NEEDS A BUSINESS CHOICE", [
      "The current typed requirements do not establish whose records these operations concern.",
      ...requirement.unresolved.map(resource => `- ${resource}`),
      "Resolve the missing scope through the existing business question before continuing. No scope was guessed or authority changed.",
    ], "warning");
    return { state: "paused", resources: requirement.unresolved };
  }
  const resourceIds = requirement.required;
  if (!resourceIds.length) return { state: "ready", changed: false };

  let changed = false;
  const savedDecisions: Array<{
    resourceId: string;
    scope: ReviewedJobPrincipalScope;
  }> = [];
  let savedReviewRevision: number | undefined;
  const reportSavedDecisions = (): void => {
    if (!savedDecisions.length) return;
    input.session.rememberDetails?.("TRUSTED USER/OWNER SCOPE SAVED", [
      ...savedDecisions.map(({ resourceId, scope }) => `${resourceId}: ${scope.label}`),
      ...(savedReviewRevision !== undefined
        ? [`Disabled Boundary revision: ${savedReviewRevision}`]
        : []),
      "Agent authority changed: no",
      "Source database changed: no",
    ]);
    input.session.present?.("TRUSTED USER/OWNER SCOPE SAVED", [
      `${savedDecisions.length} exact predicate${savedDecisions.length === 1 ? "" : "s"} recorded in the disabled draft.`,
      "Source-proven mandatory paths were carried forward without a second confirmation.",
      "The model cannot supply or change these trusted values.",
      "Agent authority remains off.",
    ], "success");
  };
  for (let pass = 0; pass < 4; pass += 1) {
    const views = await Promise.all(resourceIds.map((resourceId) =>
      inspectBoundaryResourceReview(input.projectRoot, resourceId)));
    assertRunning();
    const unresolved = views.filter((view) => !hasReviewedJobPrincipalScope(view));
    if (!unresolved.length) {
      reportSavedDecisions();
      return { state: "ready", changed };
    }

    const candidates = unresolved.map((view) => ({
      view,
      options: reviewedJobPrincipalScopeOptions(view),
    }));
    const reviewable = candidates.filter((entry) => entry.options.length > 0);
    if (!reviewable.length) {
      const blocked = unresolved.map((view) => view.resource_id).sort();
      reportSavedDecisions();
      const lines = [
        "This job promises rows belonging to the authenticated person, but Runner cannot prove a user/owner predicate for the selected resources.",
        ...blocked.map((resourceId) => `- ${resourceId}`),
        "Review a direct user/owner column or mandatory relationship path, then reopen Agent job. Tenant scope alone does not satisfy an own-row request.",
        "No additional model request occurred during this local scope check. No authority activation, source query, or source write occurred.",
      ];
      input.session.rememberDetails?.("PRINCIPAL SCOPE NEEDS REVIEW", lines);
      input.session.present?.("PRINCIPAL SCOPE NEEDS REVIEW", lines, "warning");
      return { state: "paused", resources: blocked };
    }

    const decisions: Array<{
      resourceId: string;
      scope: ReviewedJobPrincipalScope;
    }> = [];
    const conversationallyHandled = new Set<string>();
    if (input.modelSession && input.authoringChat) {
      const narrator = input.modelNarrator ?? narrateValidatedAuthoringStep;
      for (const entry of reviewable.filter(({ options }) =>
        options.length > 1 || options.some((option) => option.kind === "postgres_rls"))) {
        const reviewed = await reviewJobPrincipalScopeWithModel({
          resourceId: entry.view.resource_id,
          options: entry.options,
          jobIntent: input.jobIntent,
          session: input.session,
          modelSession: input.modelSession,
          narrator,
          ...(input.modelInterpreter ? { interpreter: input.modelInterpreter } : {}),
          authoringChat: input.authoringChat,
        });
        if (!reviewed.handled) continue;
        conversationallyHandled.add(entry.view.resource_id);
        if (!reviewed.scope) {
          reportSavedDecisions();
          return { state: "paused", resources: [entry.view.resource_id] };
        }
        decisions.push({
          resourceId: entry.view.resource_id,
          scope: reviewed.scope,
        });
      }
    }
    const remainingReviewable = reviewable.filter(({ view }) =>
      !conversationallyHandled.has(view.resource_id));
    const unique = remainingReviewable.filter((entry) => entry.options.length === 1);
    const ambiguous = remainingReviewable.filter((entry) => entry.options.length > 1);
    const automaticDerived = unique.filter(({ options }) =>
      options[0]!.confidence === "catalog_proven");
    const needsConfirmation = unique.filter(({ options }) =>
      options[0]!.confidence !== "catalog_proven");
    decisions.push(...automaticDerived.map(({ view, options }) => ({
      resourceId: view.resource_id,
      scope: options[0]!,
    })));
    if (needsConfirmation.length) {
      const exact = needsConfirmation.map(({ view, options }) =>
        `${view.resource_id}: ${options[0]!.label}`);
      const grouped = new Map<string, { scope: ReviewedJobPrincipalScope; resources: string[] }>();
      for (const { view, options } of needsConfirmation) {
        const scope = options[0]!;
        const key = `${scope.kind}:${scope.value}:${scope.confidence}`;
        const current = grouped.get(key);
        grouped.set(key, {
          scope,
          resources: [...(current?.resources ?? []), view.resource_id],
        });
      }
      const exactScope = { title: "REVIEW USER/OWNER SCOPE", lines: [
        "The job asks for rows belonging to the authenticated person.",
        ...exact,
        "Column names are candidates, not authorization proof. Runner supplies confirmed values outside model arguments.",
        "This changes only the disabled draft. Read and Action authority remain off.",
      ] };
      input.session.rememberDetails?.(exactScope.title, exactScope.lines);
      const directColumnNames = new Set(needsConfirmation.flatMap(({ options }) =>
        options[0]?.kind === "direct" ? [options[0].value] : []));
      const confirmationPrompt = directColumnNames.size === 1
        ? `For trusted user scope, does ${[...directColumnNames][0]} on these ${needsConfirmation.length} resources store the authenticated principal ID supplied by your application?`
        : `For trusted user scope, do these ${needsConfirmation.length} reviewed predicates identify the authenticated person who owns each row?`;
      const accepted = await input.session.confirm(
        confirmationPrompt,
        {
          exactDetails: exactScope,
          defaultValue: needsConfirmation.every(({ options }) =>
            options[0]!.confidence === "high" || options[0]!.confidence === "catalog_proven"),
          context: [
            "REVIEW USER/OWNER SCOPE",
            ...[...grouped.values()].map(({ scope, resources }) =>
              resources.length === 1
                ? `${resources[0]} -> ${briefPrincipalScopeLabel(scope)}`
                : `${resources.length} resources -> ${briefPrincipalScopeLabel(scope)}`),
            "Choose Yes only when your application authenticates that principal ID and every listed column stores that same owner value.",
            "Default is No because schema names alone are not authorization proof.",
            "Runner injects the value; the model cannot. Draft only. Choose View exact Runner details for every resource.",
          ],
        },
      );
      if (!accepted) {
        reportSavedDecisions();
        const blocked = needsConfirmation.map(({ view }) => view.resource_id).sort();
        return { state: "paused", resources: blocked };
      }
      decisions.push(...needsConfirmation.map(({ view, options }) => ({
        resourceId: view.resource_id,
        scope: options[0]!,
      })));
    }
    for (const { view, options } of ambiguous) {
      const selected = await input.session.chooseOption?.(
        `CHOOSE USER/OWNER SCOPE - ${view.resource_id}`,
        [
          ...options.map((option, index) => ({
            value: `scope:${index}`,
            label: option.label,
            detail: "Runner binds this reviewed predicate from trusted context; the model never supplies it.",
          })),
          {
            value: "back",
            label: "Pause and review this resource manually",
            detail: "Do not guess. The disabled catalog and active authority remain unchanged.",
          },
        ],
        {
          initialValue: "back",
          requireExplicitSelection: true,
          context: [
            "AMBIGUOUS USER/OWNER SCOPE",
            `${view.resource_id} has more than one structurally plausible principal predicate.`,
            "Choose the exact business owner path, or pause. Runner will not infer one from a friendly name.",
          ],
        },
      );
      if (!selected || selected === "back") {
        reportSavedDecisions();
        return { state: "paused", resources: [view.resource_id] };
      }
      const index = Number(selected.slice("scope:".length));
      const scope = options[index];
      if (!scope) {
        reportSavedDecisions();
        return { state: "paused", resources: [view.resource_id] };
      }
      decisions.push({ resourceId: view.resource_id, scope });
    }

    if (!decisions.length) {
      const blocked = unresolved.map((view) => view.resource_id).sort();
      reportSavedDecisions();
      return { state: "paused", resources: blocked };
    }
    const currentRequirement = await input.resolveRequirement(requested);
    if (currentRequirement.unresolved.length || JSON.stringify(currentRequirement.required) !== JSON.stringify(resourceIds))
      throw new Error("AUTHORING_SUBJECT_REQUIREMENT_CHANGED: The typed subject requirement changed during review. No scope was saved.");
    const actor = input.actor();
    const reason = "The reviewed job explicitly requires authenticated user/owner row isolation.";
    assertRunning();
    const preview = await prepareBoundaryReviewMutationBatch(
      input.projectRoot,
      decisions.map(({ resourceId, scope }): BoundaryResourceReviewRequest => ({
        resource_id: resourceId,
        ...(scope.kind === "direct"
          ? { principal_key: scope.value }
          : scope.kind === "derived"
            ? { principal_scope_path: scope.value }
            : { principal_rls_setting: scope.value }),
        actor,
        reason,
      })),
      input.schemaInspector,
    );
    assertRunning();
    await input.onPrepared?.(structuredClone(preview));
    assertRunning();
    // Once started, the atomic commit must finish before cancellation unwinds.
    const committed = await commitBoundaryReviewMutationBatch(input.projectRoot, preview);
    await input.onCommitted?.({ preview: structuredClone(preview), committed: structuredClone(committed) });
    assertRunning();
    changed = true;
    savedDecisions.push(...decisions);
    savedReviewRevision = committed.review_revision;
  }

  const remaining = (await Promise.all(resourceIds.map((resourceId) =>
    inspectBoundaryResourceReview(input.projectRoot, resourceId))))
    .filter((view) => !hasReviewedJobPrincipalScope(view))
    .map((view) => view.resource_id)
    .sort();
  reportSavedDecisions();
  return remaining.length
    ? { state: "paused", resources: remaining }
    : { state: "ready", changed };
}


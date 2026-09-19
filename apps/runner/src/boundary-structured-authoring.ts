import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Ajv2020 } from "ajv/dist/2020.js";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  buildActionRuleAuthoringCatalog,
} from "./action-rule-authoring.js";
import {
  actionRuleModelDraftFromAuthority,
  compactActionRuleAuthoringCatalog,
  compileActionRuleModelDraft,
  type ActionRuleModelDraftV1,
} from "./action-rule-draft.js";
import { rolePostureFingerprint, schemaFingerprintForInspection } from "./auto-boundary.js";
import {
  buildActionRuleAuthorityDraft,
  readActionRuleAuthorityActivation,
  readActionRuleAuthorityDraft,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
} from "./action-rule-authority.js";
import { actionRuleModelDraftJsonSchema } from "./action-rule-model.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import {
  parseBoundaryReviewDecisionFile,
  parseBoundaryReviewResources,
} from "./boundary-review-decision-file.js";
import {
  prepareBoundaryReviewMutationBatch,
  type BoundaryResourceReviewRequest,
  type BoundaryReviewMutationBindings,
} from "./boundary-review-mutation.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { cliCommandName } from "./cli-command-meta.js";
import { redactCliErrorMessage } from "./cli-logging.js";
import { assertKnownOptions, optionalArg } from "./cli-options.js";
import { shellQuote } from "./cli-format.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { assertReadAuthoringBindings, type ReadAuthoringBindings } from "./control-policy-record.js";
import { preparedReadAuthoringDraft, readAuthoringCatalog } from "./control-policy-read-authoring.js";
import { rebindActionCatalogForReadPolicyRevision } from "./action-rule-read-revision.js";
import { loadActionRuleIntentSkeletons } from "./action-rule-intent-skeleton.js";
import { openBoundProjectControlPolicies } from "./control-policy-store.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import { resolveSynapsorProject } from "./project-resolution.js";
import { createBoundaryReviewInteractiveSession, type BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { reviewActionVersionField } from "./action-rule-version-review.js";
import type { ReviewedActionVersionField } from "./action-rule-authoring-checkpoint.js";

const INPUT_VERSION = "synapsor.boundary-draft-input.v1" as const;
const EXTERNAL_DRAFT_ACTOR = "external_draft";
// The exported envelope must always be eligible for unchanged re-submission.
const MAX_DRAFT_BYTES = 512 * 1024;

let structuredActionDraftValidator: ReturnType<Ajv2020["compile"]> | undefined;

type JsonRecord = Record<string, unknown>;
type StructuredRuleSource = Parameters<typeof buildActionRuleAuthorityDraft>[0]["rules"][number];
type StructuredActionEntry = { draft: ActionRuleModelDraftV1; retained?: StructuredRuleSource };

type StructuredBoundaryDraftInput = {
  schema_version: typeof INPUT_VERSION;
  review_bundle_digest: `sha256:${string}`;
  bindings: BoundaryReviewMutationBindings;
  read: { resources: JsonRecord[] };
  actions: ActionRuleModelDraftV1[];
};

/**
 * Public typed authoring exports templates or saves disabled Read/Action
 * revisions. Optional counter selection uses the existing operator-terminal
 * review; Read/Action activation remains separate.
 */
export async function structuredBoundaryAuthoringCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
  counterReviewSession?: BoundaryReviewInteractiveSession,
): Promise<number> {
  try {
    return await structuredBoundaryAuthoringCommandInner(args, schemaInspector, counterReviewSession);
  } catch (error) {
    if (!args.includes("--json")) throw error;
    const code = structuredErrorCode(error);
    const publicationUnconfirmed = (error as { structured_publication_unconfirmed?: unknown } | null)
      ?.structured_publication_unconfirmed === true;
    const message = structuredErrorMessage(error, code);
    write(args, {
      ok: false,
      code,
      message,
      ...(structuredErrorNextAction(code) ? { next_action: structuredErrorNextAction(code) } : {}),
      source_database_changed: false,
      active_authority_changed: false,
      ...(publicationUnconfirmed ? { disabled_authority_changed: "unknown" } : { disabled_authority_changed: false }),
    });
    return 2;
  }
}

async function structuredBoundaryAuthoringCommandInner(
  args: string[],
  schemaInspector: typeof inspectDatabase,
  counterReviewSession?: BoundaryReviewInteractiveSession,
): Promise<number> {
  assertKnownOptions(args, new Set([
    "--project-root", "--export-draft", "--draft", "--json", "--dry-run", "--review-counters",
  ]), "boundary structured authoring");
  const exportPath = optionalArg(args, "--export-draft");
  const draftPath = optionalArg(args, "--draft");
  if (Boolean(exportPath) === Boolean(draftPath)) {
    throw new Error("Provide exactly one of --export-draft <file> or --draft <file>.");
  }
  if (exportPath && args.includes("--dry-run")) {
    throw new Error("--dry-run applies only to --draft validation; export does not change authority.");
  }
  if (args.includes("--review-counters")) {
    if (!draftPath) throw new Error("--review-counters requires --draft <file>; it reviews the submitted UPDATE targets.");
    // The typed file and --json never supply or imply source-owner consent.
    if (!counterReviewSession && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw Object.assign(new Error("Counter review requires a real terminal for the source owner's explicit confirmation. No draft was saved."),
        { code: "ACTION_VERSION_REVIEW_TERMINAL_REQUIRED" });
    }
    counterReviewSession ??= createBoundaryReviewInteractiveSession();
  } else counterReviewSession = undefined;
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  // Reject malformed input before coordination can create local gate files.
  const input = draftPath
    ? parseStructuredDraftInput(await readBoundedJson(projectFile(projectRoot, draftPath, "--draft"), MAX_DRAFT_BYTES))
    : undefined;
  // Export/preview must not advertise a saveable execution-backed project
  // whose reviewed runtime binding is already unavailable. No authority changes;
  // persistence repeats the check after preparation and under writer exclusion.
  await withProjectRuntimeAdmission(projectRoot, async (root) => {
    const binding = await openBoundProjectControlPolicies(root);
    if (!binding) return;
    try {
      const config = await structuredExecutionContext(root, binding);
      if (config) await new OperatorAuthorityRepository(binding, config).current();
    } finally { await binding.close(); }
  });
  if (exportPath) {
    const payload = await exportStructuredDraft(projectRoot, schemaInspector);
    const target = await newExportFile(projectRoot, exportPath);
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_DRAFT_BYTES) {
      throw new Error(`STRUCTURED_DRAFT_EXPORT_TOO_LARGE: exact export is ${Buffer.byteLength(text, "utf8")} bytes; limit is ${MAX_DRAFT_BYTES}. Narrow the initialized Read boundary before exporting; Runner did not truncate metadata.`);
    }
    await fs.writeFile(target, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    write(args, { ok: true, state: "exported", path: path.relative(projectRoot, target), source_database_changed: false });
    return 0;
  }

  const prepared = await prepareStructuredDraft(projectRoot, input!, schemaInspector, counterReviewSession);
  if (args.includes("--dry-run")) {
    write(args, { ok: true, state: "validated_disabled_preview", ...prepared.summary, source_database_changed: false });
    return 0;
  }
  const persisted = await persistStructuredDraft(projectRoot, prepared);
  write(args, { ok: true, state: "saved_disabled", ...prepared.summary, policy_epoch: persisted,
    next_steps: structuredReviewNextSteps(projectRoot, Boolean(prepared.action)), source_database_changed: false });
  return 0;
}

async function exportStructuredDraft(projectRoot: string, schemaInspector: typeof inspectDatabase) {
  const context = await loadBoundaryReviewContext(projectRoot);
  const inspection = await schemaInspector({
    engine: context.lock.engine,
    databaseUrlEnv: context.lock.source_env,
    schema: context.lock.inspected_schema,
    env: process.env,
  });
  if (schemaFingerprintForInspection(inspection) !== context.lock.schema_fingerprint
    || rolePostureFingerprint(inspection) !== context.lock.role_posture_fingerprint) {
    throw new Error("STRUCTURED_DRAFT_STALE: the schema or database-role posture changed during validation. Run boundary rescan, export a new draft, and submit against that exact review bundle.");
  }
  const authoring = await readProjectReadAuthoring(projectRoot);
  const selected = authoring?.selected;
  const exportReadCatalog = selected?.catalog?.review ?? await readFreshReadCatalog(projectRoot);
  const existing = await readActionRuleAuthorityDraft(projectRoot, `${context.candidate.pack.name}_rules`)
    ?? await readActionRuleAuthorityActivation(projectRoot);
  const matchingAction = existing?.authority.name === `${context.candidate.pack.name}_rules`
    ? existing
    : undefined;
  const retainedCatalog = matchingAction?.authority.catalog;
  if (retainedCatalog
    && retainedCatalog.generation_lock_fingerprint !== context.candidate.generation_lock_fingerprint) {
    throw new Error("ACTION_RULE_REVISION_STALE: the saved Action authority was built from a different inspected schema revision. Re-review the Read and Action dependency before exporting a combined structured draft.");
  }
  // A saved Action bundle may deliberately retain private verification-only
  // resources outside the current Read candidate. Export the same bounded
  // catalog that submission will validate; never make those resources vanish.
  const catalog = buildActionRuleAuthoringCatalog({ boundary: context.candidate, inspection,
    ...(retainedCatalog ? { retainedCatalog } : {}) });
  const baselineActions = matchingAction?.authority.rules.map((rule) => {
    const review = matchingAction.reviews.find((entry) => entry.outcome === rule.rule.outcome);
    if (!review) throw new Error(`STRUCTURED_DRAFT_ACTION_REVIEW_MISSING: saved outcome ${rule.rule.outcome} has no review summary.`);
    return actionRuleModelDraftFromAuthority({
      authority: matchingAction.authority,
      outcome: rule.rule.outcome,
      review,
      preserveVerificationFields: true,
    });
  }) ?? [];
  const actionSkeletons = await loadActionRuleIntentSkeletons({
    projectRoot,
    binding: {
      boundary_name: context.candidate.pack.name,
      generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
      schema_fingerprint: context.lock.schema_fingerprint,
      role_posture_fingerprint: context.lock.role_posture_fingerprint,
    },
    builtCatalog: catalog,
    readBoundaryDigest: context.bundle.candidate_digest,
    preparedDrafts: baselineActions.map((draft) => ({
      outcome: draft.outcome,
      digest: canonicalJsonDigest(draft),
      draft,
    })),
  });
  const bootstrapResource = context.candidate.pack.resources.length === 0
    ? exportReadCatalog?.resources[0]?.id
    : undefined;
  if (context.candidate.pack.resources.length === 0 && !bootstrapResource) {
    throw new Error("STRUCTURED_DRAFT_BOOTSTRAP_CATALOG_MISSING: the disabled metadata-only Read draft has no governed resource catalog. Re-run boundary draft; Runner will not infer a table from an empty candidate.");
  }
  const payload = {
    schema_version: INPUT_VERSION,
    review_bundle_digest: context.bundle.bundle_digest,
    bindings: context.bundle.mutation_bindings,
    read: {
      resources: bootstrapResource ? [{ resource_id: bootstrapResource, include: true }] : context.candidate.pack.resources.map((resource) => ({
        resource_id: resource.id,
        include: true,
      })),
    },
    actions: baselineActions,
    // Incomplete context from a current saved model job. It is not an input to
    // the submission parser and cannot become Action authority by itself.
    action_skeletons: actionSkeletons.skeletons,
    read_request_json_schema: structuredReadRequestJsonSchema(),
    action_rule_draft_json_schema: actionRuleModelDraftJsonSchema(),
    action_authoring_catalog: compactActionRuleAuthoringCatalog(catalog.authoring),
    read_authoring_catalog: exportReadCatalog ? structuredClone(exportReadCatalog) : undefined,
    notes: {
      state: "template_only",
      provenance: EXTERNAL_DRAFT_ACTOR,
      activation: "not_available_from_this_input",
      instructions: "Edit typed read.resources and actions only. action_skeletons are view-only incomplete context, not ready actions; Runner ignores them on submission. The export contains no identity values, confirmations, activation authority, credentials, source rows, or runtime grants. A submission must request at least one real Read or Action change; all saved revisions remain disabled for separate human review.",
    },
  };
  return payload;
}

async function readFreshReadCatalog(projectRoot: string): Promise<{ resources: JsonRecord[] } | undefined> {
  const target = path.join(projectRoot, ".synapsor", "review-report.json");
  try {
    const review = record(await readBoundedJson(target, MAX_DRAFT_BYTES), "saved Read metadata catalog");
    if (!Array.isArray(review.resources)) throw new Error("saved Read metadata catalog.resources must be an array.");
    const resources = review.resources.map((resource, index) => {
      const parsed = record(resource, `saved Read metadata catalog.resources[${index}]`);
      text(parsed.id, `saved Read metadata catalog.resources[${index}].id`, 256);
      return parsed;
    });
    return { ...review, resources };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function prepareStructuredDraft(
  projectRoot: string,
  input: StructuredBoundaryDraftInput,
  schemaInspector: typeof inspectDatabase,
  counterReviewSession?: BoundaryReviewInteractiveSession,
) {
  const context = await loadBoundaryReviewContext(projectRoot);
  if (input.review_bundle_digest !== context.bundle.bundle_digest) {
    throw new Error("STRUCTURED_DRAFT_STALE: review_bundle_digest is not the current exact Read review bundle. Export a new draft template; no authority changed.");
  }
  if (canonicalJsonDigest(input.bindings) !== canonicalJsonDigest(context.bundle.mutation_bindings)) {
    throw new Error("STRUCTURED_DRAFT_STALE: bindings do not match the current exact Read review bundle. Export a new draft template; no authority changed.");
  }
  const requests = structuredReadRequests(input.read.resources);
  if (!requests.length && !input.actions.length) {
    throw new Error("STRUCTURED_DRAFT_CHANGE_REQUIRED: include at least one Read request or one ActionRuleModelDraftV1 entry.");
  }
  const read = requests.length
    ? await prepareBoundaryReviewMutationBatch(projectRoot, requests, schemaInspector, input.bindings)
    : undefined;
  const prospectiveRead = read?.candidate ?? context.candidate;
  const prospectiveLock = read?.build.lock ?? context.lock;
  if (prospectiveLock.schema_fingerprint !== context.lock.schema_fingerprint
    || prospectiveLock.role_posture_fingerprint !== context.lock.role_posture_fingerprint) {
    throw new Error("STRUCTURED_DRAFT_STALE: inspected schema or database-role posture changed. Run boundary rescan, export a new draft, and submit against that exact review bundle.");
  }
  const inspection = await schemaInspector({
    engine: prospectiveLock.engine,
    databaseUrlEnv: prospectiveLock.source_env,
    schema: prospectiveLock.inspected_schema,
    env: process.env,
  });
  if (schemaFingerprintForInspection(inspection) !== prospectiveLock.schema_fingerprint
    || rolePostureFingerprint(inspection) !== prospectiveLock.role_posture_fingerprint) {
    throw new Error("STRUCTURED_DRAFT_STALE: the schema or database-role posture changed during validation. Run boundary rescan, export a new draft, and submit against that exact review bundle.");
  }
  const readDigest = read?.candidate_digest ?? context.bundle.candidate_digest;
  let existing: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1 | undefined = await readActionRuleAuthorityDraft(projectRoot, `${prospectiveRead.pack.name}_rules`);
  if (!existing) {
    const active = await readActionRuleAuthorityActivation(projectRoot);
    if (active?.authority.name === `${prospectiveRead.pack.name}_rules`) existing = active;
  }
  if (existing && existing.authority.catalog.generation_lock_fingerprint !== prospectiveRead.generation_lock_fingerprint
    && existing.authority.rules.some((rule) => rule.read_boundary_name !== prospectiveRead.pack.name)) {
    throw new Error("ACTION_RULE_READ_REVIEW_REQUIRED: this Action bundle also depends on another Read Boundary. Review both dependencies together before changing their generation lock. The saved Read and Action drafts are unchanged.");
  }
  const retainedCatalog = existing?.authority.catalog === undefined ? undefined
    : existing.authority.catalog.generation_lock_fingerprint === prospectiveRead.generation_lock_fingerprint
      ? existing.authority.catalog
      : rebindActionCatalogForReadPolicyRevision({
        catalog: existing.authority.catalog,
        previousLock: context.lock,
        nextLock: prospectiveLock,
        nextBoundary: prospectiveRead,
      });
  let catalog = buildActionRuleAuthoringCatalog({ boundary: prospectiveRead, inspection,
    ...(retainedCatalog ? { retainedCatalog } : {}) });
  const replacementDrafts = new Map<string, StructuredActionEntry>();
  for (const rule of existing?.authority.rules ?? []) {
    const review = existing!.reviews.find((entry) => entry.outcome === rule.rule.outcome);
    if (!review) throw new Error(`STRUCTURED_DRAFT_ACTION_REVIEW_MISSING: saved outcome ${rule.rule.outcome} has no review summary.`);
    const draft = actionRuleModelDraftFromAuthority({
      authority: existing!.authority,
      outcome: rule.rule.outcome,
      review,
      preserveVerificationFields: true,
    });
    const { activated_at: _activatedAt, ...source } = rule;
    replacementDrafts.set(rule.rule.outcome, { draft,
      ...(rule.read_boundary_name !== prospectiveRead.pack.name ? { retained: structuredClone(source) } : {}) });
  }
  for (const draft of input.actions) {
    if (replacementDrafts.has(draft.outcome) && input.actions.filter((item) => item.outcome === draft.outcome).length > 1) {
      throw new Error(`STRUCTURED_DRAFT_ACTION_DUPLICATE: outcome ${draft.outcome} appears more than once.`);
    }
    const previous = replacementDrafts.get(draft.outcome);
    if (previous?.retained) {
      if (canonicalJsonDigest(previous.draft) !== canonicalJsonDigest(draft)) {
        throw new Error(`STRUCTURED_DRAFT_READ_DEPENDENCY_REQUIRED: ${draft.outcome} belongs to Read Boundary ${previous.retained.read_boundary_name}, not the selected ${prospectiveRead.pack.name}. This selected-Read export cannot edit that dependency. Open boundary review and select the original Read Boundary to inspect the joint review; do not rename or duplicate the outcome. All saved work remains unchanged.`);
      }
      continue;
    }
    replacementDrafts.set(draft.outcome, { draft });
  }
  const reviewedCounters: ReviewedActionVersionField[] = [];
  const assertCounterMetadataCurrent = async () => {
    const fresh = await schemaInspector({ engine: prospectiveLock.engine, databaseUrlEnv: prospectiveLock.source_env,
      schema: prospectiveLock.inspected_schema, env: process.env });
    if (schemaFingerprintForInspection(fresh) !== prospectiveLock.schema_fingerprint
      || rolePostureFingerprint(fresh) !== prospectiveLock.role_posture_fingerprint) {
      throw new Error("ACTION_VERSION_REVIEW_STALE: inspected source metadata changed during counter review. Rescan and review again; no draft was saved.");
    }
  };
  if (counterReviewSession) {
    const targets = [...new Set(input.actions.flatMap(({ effect }) => effect.operation === "update"
      ? [effect.target_resource, ...(effect.atomic_updates?.map(member => member.target_resource) ?? [])] : []))].sort();
    if (!targets.length) throw new Error("ACTION_VERSION_REVIEW_TARGET_REQUIRED: --review-counters requires a submitted UPDATE action.");
    const assertCurrent = async () => {
      await assertCounterMetadataCurrent();
      const fresh = await loadBoundaryReviewContext(projectRoot);
      if (fresh.bundle.bundle_digest !== input.review_bundle_digest
        || canonicalJsonDigest(fresh.bundle.mutation_bindings) !== canonicalJsonDigest(input.bindings)) {
        throw new Error("ACTION_VERSION_REVIEW_STALE: the saved Read or Action review changed during counter selection. Export the current draft; no authority changed.");
      }
    };
    for (const resource of targets) {
      await assertCurrent();
      const fields = catalog.authoring.resources.find(item => item.name === resource)?.version_field_options ?? [];
      if (!fields.length) throw new Error(`ACTION_VERSION_FIELD_UNSUPPORTED: ${resource} has no inspected counter options. No draft was saved.`);
      const selected = await counterReviewSession.chooseOption?.("SELECT MAINTAINED CONFLICT COUNTER", [
        { value: "cancel", label: "Cancel this draft submission" },
        ...fields.map(field => ({ value: `field:${field}`, label: field })),
      ], { initialValue: "cancel", requireExplicitSelection: true, context: [
        `UPDATE target: ${resource}. Select the exact counter identified by the source owner.`,
        "Structurally suitable integers are not evidence of maintenance. No field is selected automatically.",
        "Confirm each counter's maintenance next. All mappings save only with the validated disabled draft; activation remains separate.",
      ] });
      if (!selected || selected === "cancel") throw new Error("ACTION_VERSION_REVIEW_CANCELLED: counter review cancelled. No Read or Action draft was saved.");
      const field = fields.find(value => selected === `field:${value}`);
      if (!field) throw new Error("ACTION_VERSION_FIELD_UNSUPPORTED: select one of the current inspected counter options. No draft was saved.");
      const prepared = await reviewActionVersionField({ context: { readBoundary: prospectiveRead, readBoundaryDigest: readDigest, builtCatalog: catalog },
        inspection, generationLock: prospectiveLock, resource, field, session: counterReviewSession, assertCurrent });
      if (!prepared) throw new Error("ACTION_VERSION_REVIEW_CANCELLED: source-owner maintenance confirmation is pending. No Read or Action draft was saved.");
      catalog = prepared.builtCatalog;
      reviewedCounters.push(prepared.review);
    }
  }
  const action = compileStructuredActionBundle({ entries: [...replacementDrafts.values()], catalog,
    readBoundary: prospectiveRead, readDigest,
    authorityName: existing?.authority.name ?? `${prospectiveRead.pack.name}_rules`,
    actionBoundaryName: existing?.authority.action_boundary.name ?? `${prospectiveRead.pack.name}_actions` });
  const current = read ? await readProjectReadAuthoring(projectRoot) : undefined;
  if (read && (!current?.selected || !current.selected.catalog || !read.bindings.authoring)) {
    throw new Error("STRUCTURED_DRAFT_REPOSITORY_REQUIRED: initialize the current disabled Read draft in governed policy storage before submitting a Read change.");
  }
  const progress = read && createBoundaryReviewProgress({
    draft: preparedReadAuthoringDraft(read.build),
    candidate: read.candidate,
    confirmedDecisions: [],
    previous: read.previous_progress,
    reviewOverrides: read.build.overrides,
    actor: EXTERNAL_DRAFT_ACTOR,
    reason: "External structured draft pending human review.",
    revision: read.bindings.review_revision + 1,
  });
  const authoring = read && current && progress ? (() => {
    const next = structuredClone(current.authoring);
    next.entries = next.entries.map((entry) => entry.progress.boundary_id !== current.selected!.progress.boundary_id
      ? entry
      : {
          draft: preparedReadAuthoringDraft(read.build),
          draft_lock: read.build.lock,
          candidate_lock: read.build.lock,
          progress,
          catalog: readAuthoringCatalog(read.build),
        });
    return next;
  })() : undefined;
  return {
    read,
    action,
    authoring,
    authoring_binding: input.bindings.authoring,
    ...(reviewedCounters.length ? { assertCounterMetadataCurrent } : {}),
    summary: {
      review_bundle_digest: input.review_bundle_digest,
      read_candidate_digest: readDigest,
      ...(action ? { action_authority_digest: action.digest,
        action_outcomes: action.authority.rules.map((rule) => rule.rule.outcome).sort() } : {}),
      confirmed_read_decisions: 0,
      ...(reviewedCounters.length ? { reviewed_conflict_counters: reviewedCounters } : {}),
      activation: "unsupported_from_structured_authoring",
      provenance: EXTERNAL_DRAFT_ACTOR,
    },
  };
}

function compileStructuredActionBundle(input: {
  entries: StructuredActionEntry[];
  catalog: ReturnType<typeof buildActionRuleAuthoringCatalog>;
  readBoundary: Awaited<ReturnType<typeof loadBoundaryReviewContext>>["candidate"];
  readDigest: `sha256:${string}`;
  authorityName: string;
  actionBoundaryName: string;
}): ActionRuleAuthorityDraftV1 | undefined {
  if (!input.entries.length) return undefined;
  const compiled = input.entries.map(({ draft, retained }) => {
    if (retained) return { draft, source: retained };
    // Validate the original approval predicate with the normal compiler. Only
    // limits explicitly bound to other outcomes wait for joint validation.
    const compileDraft = {
      ...draft,
      approval: { ...draft.approval, shared_limits: draft.approval.shared_limits.filter((limit) =>
        limit.capability === undefined || limit.capability === draft.outcome) },
    };
    const result = compileActionRuleModelDraft({ draft: compileDraft,
      builtCatalog: input.catalog, readBoundary: input.readBoundary, readBoundaryDigest: input.readDigest,
      authorityName: input.authorityName, actionBoundaryName: input.actionBoundaryName });
    const { activated_at: _activatedAt, ...source } = result.loaded.authority.rules[0]!;
    return { draft, source };
  });
  const classes = new Map<string, typeof compiled>();
  for (const entry of compiled) {
    const name = entry.draft.approval.class_name;
    const group = classes.get(name) ?? [];
    group.push(entry); classes.set(name, group);
  }
  const approvalClasses = [...classes.values()].map((group) => {
    const first = group[0]!;
    const policy = {
      name: first.draft.approval.class_name,
      mode: first.draft.approval.mode,
      required_role: first.draft.approval.required_role,
      required_approvals: first.draft.approval.required_approvals,
    };
    const limits = [...first.draft.approval.shared_limits].sort((left, right) => left.id.localeCompare(right.id));
    for (const entry of group.slice(1)) {
      const candidatePolicy = {
        name: entry.draft.approval.class_name,
        mode: entry.draft.approval.mode,
        required_role: entry.draft.approval.required_role,
        required_approvals: entry.draft.approval.required_approvals,
      };
      const candidateLimits = [...entry.draft.approval.shared_limits].sort((left, right) => left.id.localeCompare(right.id));
      if (canonicalJsonDigest(candidatePolicy) !== canonicalJsonDigest(policy)
        || canonicalJsonDigest(candidateLimits) !== canonicalJsonDigest(limits)) {
        throw new Error(`STRUCTURED_DRAFT_APPROVAL_CLASS_CONFLICT: outcomes assigned to ${first.draft.approval.class_name} must retain one exact approval policy and shared limit set.`);
      }
    }
    return {
      ...policy,
      shared_limits: structuredClone(limits),
      rules: group.map((entry) => ({ outcome: entry.source.rule.outcome,
        ...(entry.draft.approval.mode === "policy" ? { auto_approve_when: structuredClone(entry.draft.approval.auto_approve_when) } : {}) })),
    };
  });
  return buildActionRuleAuthorityDraft({
    name: input.authorityName,
    action_boundary_name: input.actionBoundaryName,
    catalog: input.catalog.catalog,
    rules: compiled.map((entry) => entry.source),
    approval_classes: approvalClasses,
    reviews: compiled.map((entry) => ({ outcome: entry.source.rule.outcome, ...entry.draft.review })),
  });
}

async function persistStructuredDraft(
  projectRoot: string,
  prepared: Awaited<ReturnType<typeof prepareStructuredDraft>>,
): Promise<number> {
  return withProjectRuntimeAdmission(projectRoot, (root) => withProjectAuthorityMutation(root, async (held) => {
    await prepared.assertCounterMetadataCurrent?.();
    const binding = await openBoundProjectControlPolicies(held.projectRoot);
    if (!binding) throw new Error("STRUCTURED_DRAFT_REPOSITORY_REQUIRED: governed policy storage is required for disabled publication.");
    try {
      const config = await structuredExecutionContext(held.projectRoot, binding);
      const repository = new OperatorAuthorityRepository(binding, config);
      const current = await repository.current();
      assertCurrentAuthoringBinding(prepared.authoring_binding, binding, current);
      const companion = prepared.action ? [{
        key: { scope: { level: "operator" as const }, kind: "action" as const, name: prepared.action.authority.name },
        policy: { type: "action" as const, authority: prepared.action },
      }] : [];
      if (prepared.read && prepared.authoring) {
        const expected = prepared.read.bindings.authoring;
        if (!expected) throw new Error("STRUCTURED_DRAFT_REPOSITORY_REQUIRED: Read publication lacks the exact governed authoring binding.");
        try {
          const result = await repository.commitReadAuthoring({
            expected_epoch: expected.epoch,
            expected_revision_id: expected.revision_id,
            authoring: prepared.authoring,
            actor: EXTERNAL_DRAFT_ACTOR,
            operation: "save_structured_disabled_read_and_action",
            ...(companion.length ? { additionalDrafts: companion } : {}),
          });
          return result.epoch;
        } catch (error) {
          throw markPublicationUnconfirmed(error);
        }
      }
      if (!prepared.action) throw new Error("STRUCTURED_DRAFT_CHANGE_REQUIRED: no disabled Read or Action change was prepared.");
      try {
        const result = await repository.commit({
          expected_epoch: current.epoch,
          drafts: companion,
          actor: EXTERNAL_DRAFT_ACTOR,
          operation: "save_structured_disabled_action",
        });
        return result.epoch;
      } catch (error) {
        throw markPublicationUnconfirmed(error);
      }
    } finally {
      await binding.close();
    }
  }));
}

/** Resolve existing execution, never execution material from the edited draft.
 * The managed local entry selects the reviewed Action companion and verifies
 * its actual store/project and execution digest. No execution record means no
 * new writer, runtime file or client prerequisite for disabled authoring. */
async function structuredExecutionContext(projectRoot: string,
  binding: NonNullable<Awaited<ReturnType<typeof openBoundProjectControlPolicies>>>) {
  const execution = await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id,
    scope: { level: "operator" }, kinds: ["execution"] });
  if (!execution.active.length && !execution.drafts.length) return undefined;
  const selected = await resolveSynapsorProject(projectRoot);
  if (selected) {
    const relative = path.relative(projectRoot, await fs.realpath(selected.config_path));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("POLICY_RUNTIME_PROJECT_CHANGED: structured authoring requires this project's reviewed runtime configuration.");
    }
  }
  const { readLocalExploreRuntimeConfig } = await import("./mcp-runtime.js");
  const config = await readLocalExploreRuntimeConfig(projectRoot, selected?.config_path);
  if (!config) throw new Error("POLICY_EXECUTION_CONTEXT_REQUIRED: restore this project's reviewed runtime configuration before exporting or saving a disabled draft.");
  return config;
}

function assertCurrentAuthoringBinding(expected: ReadAuthoringBindings | undefined,
  binding: NonNullable<Awaited<ReturnType<typeof openBoundProjectControlPolicies>>>,
  current: Awaited<ReturnType<OperatorAuthorityRepository["current"]>>): void {
  const authoring = current.active.find((entry) => entry.policy.type === "read_authoring");
  if (!authoring) {
    throw new Error("STRUCTURED_DRAFT_REPOSITORY_REQUIRED: the governed Read authoring record is unavailable.");
  }
  assertReadAuthoringBindings(expected, {
    repository_id: binding.repository_id,
    deployment_id: binding.deployment_id,
    project_id: binding.project_id,
    epoch: current.epoch,
    revision_id: authoring.revision.revision_id,
  });
}

function parseStructuredDraftInput(value: unknown): StructuredBoundaryDraftInput {
  const root = record(value, "structured boundary draft");
  assertKeys(root, [
    "schema_version", "review_bundle_digest", "bindings", "read", "actions",
    "action_skeletons", "read_request_json_schema", "action_rule_draft_json_schema", "action_authoring_catalog", "read_authoring_catalog", "notes",
  ], "structured boundary draft");
  if (root.schema_version !== INPUT_VERSION) throw new Error(`structured boundary draft must use ${INPUT_VERSION}.`);
  const read = record(root.read, "read");
  assertKeys(read, ["resources"], "read");
  if (!Array.isArray(read.resources) || read.resources.length > 500) {
    throw new Error("structured boundary draft read.resources must contain at most 500 resource requests.");
  }
  if (!Array.isArray(root.actions) || root.actions.length > 12) {
    throw new Error("structured boundary draft actions must contain at most 12 ActionRuleModelDraftV1 entries.");
  }
  if (root.action_skeletons !== undefined
    && (!Array.isArray(root.action_skeletons) || root.action_skeletons.length > 12)) {
    throw new Error("structured boundary draft action_skeletons must be an export-only array of at most 12 entries.");
  }
  return {
    schema_version: INPUT_VERSION,
    review_bundle_digest: hash(root.review_bundle_digest, "review_bundle_digest"),
    bindings: parseBindings(root.bindings),
    read: { resources: read.resources.map((item, index) => record(item, `read.resources[${index}]`)) },
    actions: root.actions.map((item, index) => parseStructuredActionDraft(item, index)),
  };
}

/**
 * The action compiler owns semantic validation of the complete typed action
 * language. This structural check uses the same schema supplied in the export,
 * rejects unknown fields and never coerces, defaults or removes input values.
 */
function parseStructuredActionDraft(value: unknown, index: number): ActionRuleModelDraftV1 {
  const label = `actions[${index}]`;
  const draft = record(value, label);
  const validator = structuredActionDraftValidator ??= new Ajv2020({ strict: false, allErrors: true })
    .compile(actionRuleModelDraftJsonSchema());
  if (!validator(draft)) {
    const errors = (validator.errors ?? []).slice(0, 6).map((error) => {
      const location = error.instancePath || "/";
      return `${location} ${error.message ?? error.keyword}`.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 180);
    });
    throw new Error(`ACTION_RULE_DRAFT_SHAPE_INVALID: ${label} does not match the exported ActionRuleModelDraftV1 schema${errors.length ? ` (${errors.join("; ")})` : "."}`);
  }
  assertKeys(draft, [
    "schema_version", "name", "outcome", "discovery", "inputs", "verification", "effect",
    "require", "derive", "approval", "ttl_seconds", "review",
  ], label);
  if (draft.schema_version !== "synapsor.action-rule-model-draft.v1") {
    throw new Error(`${label}.schema_version must be synapsor.action-rule-model-draft.v1.`);
  }
  const approval = record(draft.approval, `${label}.approval`);
  assertKeys(approval, [
    "class_name", "mode", "auto_approve_when", "required_role", "required_approvals", "shared_limits",
  ], `${label}.approval`);
  if (approval.mode !== "human" && approval.mode !== "policy") {
    throw new Error(`${label}.approval.mode must be human or policy.`);
  }
  if (!Array.isArray(approval.shared_limits)) {
    throw new Error(`${label}.approval.shared_limits must be an array.`);
  }
  if (approval.mode === "human") {
    if (approval.auto_approve_when !== undefined) {
      throw new Error(`${label}.approval.auto_approve_when is not allowed for human approval.`);
    }
    if (approval.shared_limits.length !== 0) {
      throw new Error(`${label}.approval.shared_limits must be empty for human approval.`);
    }
  } else if (!approval.auto_approve_when || typeof approval.auto_approve_when !== "object"
    || Array.isArray(approval.auto_approve_when)) {
    throw new Error(`${label}.approval.auto_approve_when must be a policy predicate.`);
  }
  return draft as ActionRuleModelDraftV1;
}

function structuredReadRequestJsonSchema(): Record<string, unknown> {
  const identifier = { type: "string", minLength: 1, maxLength: 256 };
  const identifierList = { type: "array", maxItems: 500, uniqueItems: true, items: identifier };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["resource_id"],
    properties: {
      resource_id: identifier,
      include: { type: "boolean" }, exclude: { type: "boolean" },
      row_identity: identifier, tenant_key: identifier, tenant_scope_path: identifier,
      shared_reference_scope: { const: "table_has_no_per_tenant_rows" },
      principal_key: { oneOf: [identifier, { type: "null" }] },
      principal_scope_path: { oneOf: [identifier, { type: "null" }] },
      principal_rls_setting: { oneOf: [identifier, { type: "null" }] },
      metadata: { type: "object", additionalProperties: false,
        properties: { label: { oneOf: [{ type: "string", minLength: 1, maxLength: 64 }, { type: "null" }] },
          description: { oneOf: [{ type: "string", minLength: 1, maxLength: 280 }, { type: "null" }] } } },
      field_metadata: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false,
        required: ["field"], properties: { field: identifier,
          label: { oneOf: [{ type: "string", minLength: 1, maxLength: 64 }, { type: "null" }] },
          description: { oneOf: [{ type: "string", minLength: 1, maxLength: 280 }, { type: "null" }] } } } },
      keep_out_fields: identifierList, withhold_from_model_fields: identifierList,
      allow_reviewed_fields: identifierList, selectable_fields: identifierList,
      filterable_fields: identifierList, sortable_fields: identifierList,
      groupable_fields: identifierList, allow_exact_numeric_grouping_fields: identifierList,
      remove_exact_numeric_grouping_fields: identifierList, aggregate_measures: identifierList,
      count_distinct_fields: identifierList, time_bucket_fields: identifierList,
      relationship_ids: identifierList, private_model_fields: identifierList,
      preserve_unselected_fields: identifierList,
      minimum_cohort_size: { type: "integer", minimum: 1, maximum: 5 },
      nullable_relationship: { type: "object", additionalProperties: false,
        required: ["relationship_id", "unmatched_rows"], properties: { relationship_id: identifier,
          unmatched_rows: { enum: ["exclude", "keep_null"] } } },
      field_enum: { type: "object", additionalProperties: false, required: ["field", "values"],
        properties: { field: identifier, values: { type: "array", minItems: 1, maxItems: 256,
          uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } } } },
    },
  };
}

/** Input has no caller identity, review confirmation or timestamp. Those
 * facts are fixed by this service and the normal human-review path. Existing
 * boundary validation remains the semantic authority for every field. */
function structuredReadRequests(resources: JsonRecord[]): BoundaryResourceReviewRequest[] {
  return parseBoundaryReviewResources(resources, {
    actor: EXTERNAL_DRAFT_ACTOR,
    reason: "External structured draft; pending human review.",
  });
}

function projectFile(projectRoot: string, supplied: string, label: string): string {
  const resolved = path.resolve(projectRoot, supplied);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must name a file inside --project-root.`);
  }
  return resolved;
}

async function newExportFile(projectRoot: string, supplied: string): Promise<string> {
  const root = await fs.realpath(projectRoot);
  const target = projectFile(root, supplied, "--export-draft");
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep);
  if (segments[0] === ".synapsor" || (segments[0] === "synapsor" && segments[1] === "generated")) {
    throw new Error("--export-draft must not write under a Runner authority or generated-artifact directory.");
  }
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    const entry = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entry) {
      await fs.mkdir(directory, { mode: 0o700 });
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("--export-draft parent directories must be real project-local directories.");
    }
  }
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) throw new Error("--export-draft refuses to overwrite an existing project file.");
  return target;
}

async function readBoundedJson(file: string, maximum: number): Promise<unknown> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`structured draft is not a private regular file: ${file}`);
    const buffer = Buffer.allocUnsafe(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new Error(`STRUCTURED_DRAFT_TOO_LARGE: input exceeds ${maximum} bytes. Split the requested outcomes; Runner did not read a partial draft.`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    return JSON.parse(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("structured draft must not be a symbolic link.");
    if (error instanceof SyntaxError || (error as { code?: string }).code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
      throw new Error("STRUCTURED_DRAFT_JSON_INVALID: input must be one valid UTF-8 JSON document.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseBindings(value: unknown): BoundaryReviewMutationBindings {
  const parsed = parseBoundaryReviewDecisionFile({
    schema_version: "synapsor.boundary-review-decisions.v1",
    review_bundle_digest: `sha256:${"0".repeat(64)}`,
    bindings: value,
    actor: EXTERNAL_DRAFT_ACTOR,
    reason: "parse bindings",
    resources: [{ resource_id: "placeholder" }],
  });
  return parsed.bindings;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function assertKeys(value: JsonRecord, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unsupported field(s): ${unknown.sort().join(", ")}.`);
}

function hash(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a sha256 digest.`);
  return value as `sha256:${string}`;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`${label} must be non-empty and at most ${maximum} bytes.`);
  }
  return value;
}

function write(args: string[], value: unknown): void {
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value && typeof value === "object" ? JSON.stringify(value) : String(value)}\n`);
}

function structuredErrorCode(error: unknown): string {
  const explicit = (error as { code?: unknown } | null)?.code;
  if (explicit === "ENOENT" || explicit === "EACCES" || explicit === "EPERM" || explicit === "ELOOP") {
    return "STRUCTURED_DRAFT_INPUT_UNAVAILABLE";
  }
  if (typeof explicit === "string" && /^[A-Z][A-Z0-9_]{2,96}$/u.test(explicit)) return explicit;
  const message = error instanceof Error ? error.message : "";
  const prefix = /^([A-Z][A-Z0-9_]{2,96}):/u.exec(message)?.[1];
  return prefix ?? "STRUCTURED_DRAFT_VALIDATION_FAILED";
}

function structuredReviewNextSteps(projectRoot: string, hasAction: boolean): Record<string, string> {
  const root = shellQuote(projectRoot);
  return {
    review_read: `${cliCommandName()} boundary review --project-root ${root} --access`,
    ...(hasAction ? { review_actions: `${cliCommandName()} action review --project-root ${root}` } : {}),
  };
}

function structuredErrorMessage(error: unknown, code: string): string {
  const raw = error instanceof Error ? error.message : "";
  const safe = redactCliErrorMessage(raw)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1500);
  return safe || `Structured draft validation failed (${code}).`;
}

function structuredErrorNextAction(code: string): string | undefined {
  if (code === "ACTION_VERSION_REVIEW_TERMINAL_REQUIRED") {
    return "Run the counter review in a real operator terminal. The typed draft and --json do not supply source-owner consent; no draft-field correction is required by this refusal.";
  }
  if (code === "STRUCTURED_DRAFT_STALE" || code === "POLICY_REVISION_CONFLICT") {
    return "Export a new structured draft from the current saved review, then resubmit it.";
  }
  if (code.startsWith("STRUCTURED_DRAFT_INPUT") || code === "STRUCTURED_DRAFT_JSON_INVALID"
    || code === "STRUCTURED_DRAFT_VALIDATION_FAILED") {
    return "Correct the reported draft field and resubmit the same saved review bundle.";
  }
  return undefined;
}

function markPublicationUnconfirmed(error: unknown): Error & { structured_publication_unconfirmed: true } {
  const wrapped = error instanceof Error ? error : new Error("Disabled draft publication could not be confirmed.");
  return Object.assign(wrapped, { structured_publication_unconfirmed: true as const });
}

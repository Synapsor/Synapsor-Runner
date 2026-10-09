import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PolicySourceInspection } from "./action-rule-source-evidence.js";
import type { policyCoverageDraft } from "./authoring-policy-evidence.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { excludedFieldReview, excludedFieldReviewBinding } from "./authoring-excluded-field-records.js";
import { activePolicySource, policySourceSavedDigest, policySourceSavedDigestHeld, savePolicySources, type PolicySourceSession } from "./authoring-policy-source.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { safeTerminalText } from "./terminal-syntax.js";

/** Local metadata administration, not a business-meaning question or a model
 * tool. Only the final selected identifier is consented for transfer. */
export async function reviewExcludedFieldMetadata(input: {
  projectRoot: string; sources: PolicySourceSession; destination: string;
  source: PolicySourceInspection; currentDraft(): ReturnType<typeof policyCoverageDraft>;
  session: BoundaryReviewInteractiveSession;
  assertCurrent(): Promise<void>;
  assertCurrentHeld(permit: ProjectAuthorityMutationPermit): Promise<void>;
  assertMetadataCurrent(): Promise<void>;
  coordinated(operation: (permit: ProjectAuthorityMutationPermit) => Promise<void>): Promise<void>;
}): Promise<{ changed: boolean; summary: string }> {
  const policy = activePolicySource(input.sources);
  if (!policy) throw new Error("EXCLUDED_FIELD_SOURCE_UNAVAILABLE: Reopen the complete current Source.");
  const expectedSource = await policySourceSavedDigest(input.projectRoot, input.sources.id);
  if (expectedSource !== canonicalJsonDigest(input.sources)) throw new Error("POLICY_SOURCE_CHANGED: Reopen the current saved Source.");
  const draft = input.currentDraft();
  const binding = excludedFieldReviewBinding({ draft, source: input.source, sourceSession: input.sources.id,
    sourceDigest: policy.digest as `sha256:${string}`, destination: input.destination });
  const used = new Set([...draft.read.pack.resources.map(r => `${r.schema}.${r.table}`),
    ...Object.values(draft.runner_evidence.actions).flatMap(action => Object.values(action.scoped_bindings).map(r => r.resource))]);
  const tables = input.source.inspection.tables.filter(table => !used.has(`${table.schema}.${table.name}`));
  if (!tables.length) return { changed: false, summary: "No wholly unused inspected source needs this additional metadata proof." };
  if (tables.length > 64 || tables.some(table => table.columns.length > 160))
    throw new Error("EXCLUDED_FIELD_REVIEW_TOO_LARGE: Keep the review pending; no metadata inventory was truncated or sent.");
  const checkCurrentHeld = async (permit: ProjectAuthorityMutationPermit) => {
    if (await policySourceSavedDigestHeld(input.projectRoot, input.sources.id, permit) !== expectedSource
      || canonicalJsonDigest(binding) !== canonicalJsonDigest(excludedFieldReviewBinding({ draft: input.currentDraft(), source: input.source,
        sourceSession: input.sources.id, sourceDigest: activePolicySource(input.sources)!.digest as `sha256:${string}`, destination: input.destination })))
      throw new Error("EXCLUDED_FIELD_REVIEW_CHANGED: Source, recipient or selected program changed. No stale metadata decision was saved.");
  };
  const assertCurrentHeld = async (permit: ProjectAuthorityMutationPermit) => {
    await input.assertCurrentHeld(permit);
    await checkCurrentHeld(permit);
  };
  const assertCurrent = async () => {
    await input.assertCurrent();
    await withProjectAuthorityMutation(input.projectRoot, checkCurrentHeld);
  };
  await input.assertMetadataCurrent(); await assertCurrent();
  const description = (text: string | undefined) => text?.trim()
    ? `Catalog hint (untrusted): ${safeTerminalText(text).slice(0, 300)}` : "Business meaning is not established; inspect the exact identity in details.";
  const common = ["Runner already inspected these names locally; no source rows or values are used.",
    "Select an exact field only to show whether this complete program omits it. A name or COMMENT does not prove its business meaning or policy applicability.",
    "This cannot add Read, analysis, private verification, execution or publication rights."];
  const tableId = await input.session.chooseOption?.("PRIVACY EVIDENCE FOR AN UNUSED SOURCE", [
    { value: "back", label: "Keep the current privacy review pending" },
    ...tables.map((table, index) => ({ value: String(index), label: `Reviewed source ${index + 1}`,
      detail: `${description(table.comment)} Exact identity: ${safeTerminalText(`${table.schema}.${table.name}`)}` })),
  ], { initialValue: "back", reviewOnly: true, context: common });
  await assertCurrent();
  if (tableId === undefined || tableId === "back") return { changed: false, summary: "Unused-field metadata review left pending; nothing was sent or granted." };
  const table = tables[Number(tableId)];
  if (!table || String(Number(tableId)) !== tableId) throw new Error("EXCLUDED_FIELD_SELECTION_INVALID: Select one exact local metadata choice.");
  const fieldId = await input.session.chooseOption?.("EXACT UNUSED FIELD METADATA", [
    { value: "back", label: "Keep this field review pending" },
    ...table.columns.map((column, index) => ({ value: String(index), label: `Reviewed field ${index + 1}`,
      detail: `${description(column.comment)} Exact identity: ${safeTerminalText(column.name)}` })),
  ], { initialValue: "back", reviewOnly: true, context: common });
  await assertCurrent();
  if (fieldId === undefined || fieldId === "back") return { changed: false, summary: "Unused-field metadata review left pending; nothing was sent or granted." };
  const column = table.columns[Number(fieldId)];
  if (!column || String(Number(fieldId)) !== fieldId) throw new Error("EXCLUDED_FIELD_SELECTION_INVALID: Select one exact local metadata choice.");
  const target = { resource: `${table.schema}.${table.name}`, field: column.name };
  if (input.sources.excluded_field_reviews?.some(review => canonicalJsonDigest(review.binding) === canonicalJsonDigest(binding)
    && review.fields.some(field => canonicalJsonDigest(field) === canonicalJsonDigest(target))))
    return { changed: false, summary: "This exact unused-field metadata decision is already current for the selected Source, recipient and program." };
  const yes = await input.session.confirm("Allow this exact unused-field identifier and exclusion proof in the model review?", {
    defaultValue: false, context: [`Selected field: ${safeTerminalText(`${target.resource}.${target.field}`)}`,
      `Recipient: ${input.destination}`, `Source: ${policy.name} v${policy.version} · ${policy.digest}`,
      "Sends only this identifier, current inspection identity and its absence from the selected Read/Actions.",
      "Does not send its COMMENT, type, constraints, neighbouring fields, row values or trusted identity values.", ...common],
    exactDetails: { title: "EXACT UNUSED-FIELD METADATA CONSENT", lines: [JSON.stringify({ binding, field: target }, null, 2)] },
  });
  if (yes !== true) return { changed: false, summary: "Exact metadata transfer was not confirmed; the privacy requirement remains pending." };
  await input.assertMetadataCurrent(); await assertCurrent();
  await input.coordinated(async permit => {
    await assertCurrentHeld(permit);
    const staged = structuredClone(input.sources);
    staged.excluded_field_reviews = [...(staged.excluded_field_reviews ?? []), excludedFieldReview(binding, [target])];
    await savePolicySources(input.projectRoot, staged, { expectedDigest: expectedSource, permit });
    if (await policySourceSavedDigestHeld(input.projectRoot, staged.id, permit) !== canonicalJsonDigest(staged))
      throw new Error("EXCLUDED_FIELD_SAVE_UNCONFIRMED: The metadata decision was not confirmed on disk. Preserve the current review for inspection; no transfer was authorized by an in-memory result.");
    Object.assign(input.sources, staged);
  });
  return { changed: true, summary: "Exact unused-field metadata consent recorded. Policy applicability and complete business review still need validation; no data access or authority changed." };
}

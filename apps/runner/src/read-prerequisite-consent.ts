import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { ReviewSection } from "./read-boundary-review-view.js";
import { listSupportedReadCurrentStatePrerequisiteCandidates, listReadCurrentStatePrerequisiteSources,
  ReadPrerequisiteCatalogTooLargeError } from "./read-prerequisite.js";
import { sanitizeReadPrerequisiteMetadataForReview, validateReadPrerequisiteBusinessAnswer } from "./read-prerequisite-model.js";
import type { GenerateModelReadPrerequisiteInput, ModelReadPrerequisiteConfirmationRequest } from "./read-prerequisite-model.js";
import type { SupportedReadCurrentStatePrerequisiteCandidate } from "./read-prerequisite.js";
import { safeTerminalText } from "./terminal-syntax.js";

type DescriptionKey = keyof SupportedReadCurrentStatePrerequisiteCandidate["catalog_descriptions"];

const descriptionLabels: Record<DescriptionKey, string> = {
  source: "Source",
  state: "Status field",
  effective_from: "Effective-start field",
  effective_until: "Effective-end field",
};

function terminal(value: string): string {
  return safeTerminalText(value);
}

/** Questions return to the mapping author, not an explanation-only permission guide. */
export async function reviewReadPrerequisiteSelection(input: {
  mapping: ModelReadPrerequisiteConfirmationRequest;
  session: BoundaryReviewInteractiveSession;
  assertCurrent: () => Promise<void>;
  rememberAnswer: (question: string, answer: string) => Promise<void>;
  /** Existing question-contract adapter; provided words are captured exactly. */
  reviewCorrection?: (question: string, supplied?: string) => Promise<string | undefined>;
}): ReturnType<GenerateModelReadPrerequisiteInput["confirmSemanticSelection"]> {
  await input.assertCurrent();
  if (!input.session.chooseOption) return { state: "pending" };
  const mapping = structuredClone(input.mapping);
  const meaning = [
    ...(mapping.previous_selection ? [canonicalJsonDigest(mapping.previous_selection) === canonicalJsonDigest(mapping.selection)
      ? "Mapping unchanged: the source, identity columns, status and dates have not been corrected. Review the explanation before deciding."
      : "Revised mapping: review the new exact condition below. Your earlier question did not confirm it."] : []),
    `Authoritative evidence: ${mapping.source_description}`,
    `Qualifying status: ${mapping.positive_state_description}`,
    "The effective period includes its start and excludes its end, using database UTC time. Missing, negative, future or expired evidence denies every data query.",
    "Scope: the organization and person from the trusted session. This source stays private; no customer-readable table or source-write permission is added.",
  ];
  let correction: string | undefined;
  const selected = await input.session.chooseOption("CONFIRM ACCESS CONDITION", [
    { value: "confirm", label: "Use this exact private access condition", detail: "Save a disabled draft for review; existing active access stays unchanged." },
    { value: "revise", label: "Correct this mapping with the model", detail: "Explain the change in ordinary language; review the new proposal before confirming it." },
    { value: "pending", label: "Keep this mapping pending", detail: "Do not save or activate the proposed condition." },
  ], { initialValue: "pending", requireExplicitSelection: true, explainOnRequest: true, context: meaning,
    onModelQuestion: async (question) => { correction = question; return "revise"; },
    exactDetails: { title: "EXACT PRIVATE ACCESS CONDITION", lines: [...meaning,
      ...JSON.stringify(mapping.selection, null, 2).split("\n"),
      `Reviewed metadata fingerprint: ${mapping.metadata_digest}`,
      `Exact proposed selection: ${mapping.selection_digest}`,
    ] } });
  await input.assertCurrent();
  if (selected === "revise") {
    const question = "What should be explained or corrected in the displayed private access condition?";
    correction = input.reviewCorrection ? await input.reviewCorrection(question, correction)
      : correction ?? await input.session.promptText(question);
    await input.assertCurrent();
    if (!correction?.trim()) return { state: "pending" };
    validateReadPrerequisiteBusinessAnswer(correction);
    if (!input.reviewCorrection) await input.rememberAnswer(question, correction.trim());
    await input.assertCurrent();
    return { state: "revise", instruction: input.reviewCorrection ? correction : correction.trim() };
  }
  if (selected !== "confirm") return { state: "pending" };
  const evidence = `Use this exact private access condition: ${mapping.selection_digest}`;
  await input.rememberAnswer(meaning.join(" "), evidence);
  await input.assertCurrent();
  return { state: "confirmed", operator_evidence: evidence };
}

function candidateTupleLine(candidate: SupportedReadCurrentStatePrerequisiteCandidate, index: number): string {
  const subject = candidate.subject, current = candidate.current_state;
  return [
    `Candidate ${index + 1}:`,
    `orientation tenant=${terminal(subject.tenant_column)}, principal=${terminal(subject.principal_column)};`,
    `unique=${terminal(subject.unique_constraint)};`,
    `status=${terminal(current.state_column)} allowlist=[${current.positive_states.map((value) => terminal(JSON.stringify(value))).join(", ")}];`,
    `effective=[${terminal(current.effective_from_column)}, ${terminal(current.effective_until_column)}) UTC;`,
    `RLS required=${candidate.rls_required ? "yes" : "no"}.`,
  ].join(" ");
}

function sourceFieldName(candidate: SupportedReadCurrentStatePrerequisiteCandidate, key: Exclude<DescriptionKey, "source">): string {
  switch (key) {
    case "state": return candidate.current_state.state_column;
    case "effective_from": return candidate.current_state.effective_from_column;
    case "effective_until": return candidate.current_state.effective_until_column;
  }
}

/**
 * Displays the exact reviewed metadata without making the operator page through
 * one JSON object per candidate. Candidate order remains the canonical order.
 */
export function readPrerequisiteEvidenceReviewSections(
  candidates: SupportedReadCurrentStatePrerequisiteCandidate[],
): ReviewSection[] {
  const sourceGroups = new Map<string, Array<{ candidate: SupportedReadCurrentStatePrerequisiteCandidate; index: number }>>();
  for (const [index, candidate] of candidates.entries()) {
    const source = `${candidate.source.schema}.${candidate.source.table}`;
    const group = sourceGroups.get(source) ?? [];
    group.push({ candidate, index });
    sourceGroups.set(source, group);
  }
  return [...sourceGroups.entries()].map(([source, entries], sourceIndex) => {
    const first = entries[0]!.candidate;
    const descriptions: string[] = [];
    for (const key of ["source", "state", "effective_from", "effective_until"] as const) {
      if (key === "source") {
        const values = [...new Set(entries.flatMap(({ candidate }) => {
          const value = candidate.catalog_descriptions.source;
          return value === undefined ? [] : [value];
        }))];
        descriptions.push(...(values.length
          ? values.map(value => `${descriptionLabels.source}: ${terminal(value)}`)
          : [`${descriptionLabels.source}: no inspected catalog description.`]));
        continue;
      }
      const valuesByField = new Map<string, string[]>();
      for (const { candidate } of entries) {
        const field = sourceFieldName(candidate, key);
        const values = valuesByField.get(field) ?? [];
        const description = candidate.catalog_descriptions[key];
        if (description !== undefined && !values.includes(description)) values.push(description);
        valuesByField.set(field, values);
      }
      for (const [field, values] of valuesByField) {
        if (!values.length) {
          descriptions.push(`${descriptionLabels[key]} ${terminal(field)}: no inspected catalog description.`);
        } else {
          descriptions.push(...values.map(value => `${descriptionLabels[key]} ${terminal(field)}: ${terminal(value)}`));
        }
      }
    }
    return {
      id: `private_source_${sourceIndex + 1}`,
      title: `Private source ${sourceIndex + 1}: ${terminal(first.source.schema)}.${terminal(first.source.table)}`,
      lines: [
        `Exact source: ${terminal(source)}. Candidate tuples in this source: ${entries.length}.`,
        "Structural metadata only. No source rows or authenticated identity values are shown or sent by this review.",
        "CATALOG DESCRIPTIONS (untrusted data, grouped once for this source)",
        ...descriptions,
        "CANDIDATE TUPLES (complete reviewed order)",
        ...entries.map(({ candidate, index }) => candidateTupleLine(candidate, index)),
        `Complete reviewed tuples for this source: ${entries.length} of ${candidates.length}.`,
      ],
    } satisfies ReviewSection;
  });
}

/** Only the returned, explicitly reviewed metadata may enter the model request. */
export async function reviewReadPrerequisiteMetadata(input: {
  inspection: SchemaInspection;
  boundary: ExplorationBoundaryDraft;
  session: BoundaryReviewInteractiveSession;
  modelLabel: string;
  assertCurrent: () => Promise<void>;
}) {
  await input.assertCurrent();
  let structuralCandidates: SupportedReadCurrentStatePrerequisiteCandidate[];
  try {
    structuralCandidates = listSupportedReadCurrentStatePrerequisiteCandidates(input.inspection, input.boundary);
  } catch (error) {
    if (!(error instanceof ReadPrerequisiteCatalogTooLargeError) || !input.session.chooseOption) throw error;
    const sources = listReadCurrentStatePrerequisiteSources(input.inspection, input.boundary);
    const selected = await input.session.chooseOption("CHOOSE THE AUTHORITATIVE ACCESS SOURCE", [
      ...sources.map((source, index) => ({ value: String(index), label: `${terminal(source.schema)}.${terminal(source.table)}` })),
      { value: "pending", label: "Keep this evidence pending", detail: "No new metadata transfer or change to saved access." },
    ], { initialValue: "pending", requireExplicitSelection: true, explainOnRequest: false,
      context: ["Several sources could fit this private access check. Choose the authoritative source you want to review, or keep it pending.",
        "Names alone do not prove business meaning. This local selection sends nothing to the model; exact metadata and its meaning are reviewed next."] });
    await input.assertCurrent();
    if (selected === undefined || selected === "pending") return undefined;
    const source = sources.find((_, index) => String(index) === selected);
    if (!source) throw new Error("READ_PREREQUISITE_SOURCE_SELECTION_INVALID: Reopen the source picker; no metadata was transferred.");
    structuralCandidates = listSupportedReadCurrentStatePrerequisiteCandidates(input.inspection, input.boundary, { source });
  }
  const candidates = sanitizeReadPrerequisiteMetadataForReview(structuralCandidates);
  if (!candidates.length) {
    throw new Error("READ_PREREQUISITE_SOURCE_MISSING: No supported authoritative current-status register is available. Map a source with one record per organization and person, a declared status allowlist and UTC effective start/end dates, then rescan and resume this saved job. Keep setup pending until that source exists; authentication and related records are not substitutes.");
  }
  if (Buffer.byteLength(JSON.stringify(candidates)) > 64 * 1024) {
    throw new Error("READ_PREREQUISITE_METADATA_TOO_LARGE: The complete private-source metadata exceeds this review's limit. Narrow the inspected source scope and resume. Nothing was truncated or sent to the model; saved access is unchanged.");
  }
  if (!input.session.chooseOption) throw new Error("READ_PREREQUISITE_CONSENT_REQUIRED: Resume guided review to permit the additional private-source metadata. No metadata was transferred.");
  const sources = [...new Set(candidates.map(candidate => `${candidate.source.schema}.${candidate.source.table}`))];
  const metadataDigest = canonicalJsonDigest(candidates);
  const details = [
    `Destination: ${input.modelLabel}`,
    "Additional structural metadata only: source/field names, uniqueness, declared status allowlists, date types and catalog descriptions. No source rows or authenticated identity values.",
    "Organization/person columns follow existing reviewed scope or a complete supported foreign key. The model must still map the authoritative source, qualifying status and effective-date semantics; names alone do not establish their business meaning.",
    "If you answer this mapping's business questions, those typed answers are also sent to this same selected provider so it can complete the mapping. Do not enter secrets or source-row values.",
    `Exact metadata fingerprint: ${metadataDigest}`,
    `Complete reviewed candidate tuples: ${candidates.length}. Open View exact Runner details to browse compact source sections.`,
    "This permission grants no customer reads, source writes or activation.",
  ];
  const selected = await input.session.chooseOption("REVIEW PRIVATE ACCESS EVIDENCE", [
    { value: "allow", label: "Let the model map this private evidence", detail: "Send the exact metadata. Review its meaning before adding a disabled access condition." },
    { value: "pending", label: "Save setup pending this evidence", detail: "Send nothing new and retain the current draft." },
  ], { initialValue: "pending", requireExplicitSelection: true, explainOnRequest: true,
    context: [`The model needs structural metadata for ${sources.length} possible private status source${sources.length === 1 ? "" : "s"}.`,
      `Their data will not become customer-readable. View exact Runner details to browse all ${candidates.length} candidate tuples, fields and declared statuses before transfer.`],
    explanationContext: ["Permission to review extra structural metadata for a private current-status Read condition. No source rows, public access, writes or activation. Business meaning requires operator confirmation."],
    exactDetails: {
      title: "PRIVATE ACCESS EVIDENCE METADATA",
      summaryTitle: "PRIVATE ACCESS EVIDENCE SUMMARY",
      lines: details,
      sections: readPrerequisiteEvidenceReviewSections(candidates),
    },
  });
  if (selected !== "allow") return undefined;
  await input.assertCurrent();
  return { candidates, metadata_digest: metadataDigest };
}

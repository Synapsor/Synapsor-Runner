import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { readBoundaryRevisionCatalog } from "./read-boundary-revision-model.js";
import { activePolicySource, confirmedReadFieldMeanings, type PolicyCoverage, type PolicySourceSession } from "./authoring-policy-source.js";
import { parsePolicyCoverage, referencesReadPolicy, unresolvedPolicyPassages } from "./authoring-policy-coverage.js";
import type { policyCoverageDraft } from "./authoring-policy-evidence.js";

type Finding = {
  resource: string; field: string; label: string; raw: boolean; analysis: string[]; roles: string[];
  status: "advisory" | "business_meaning_checked" | "field_access_matches" | "policy_decision";
  evidence: string[];
};
export type ReadPrivacyReview = {
  digest: string; coverage: "current" | "unavailable" | "not_attached";
  findings: Finding[];
  /** Actual return and analysis checks for the current policy's private fields. */
  checkedPrivateFields?: number;
  checkedPrivateGroups?: string[];
  passageConcerns?: Array<{ start: number; end: number; interpretation: string; hasFieldChecks: boolean }>;
};

/** Presentation evidence only. Never modifies a permission or waives policy readiness. */
export function readPrivacyReview(input: {
  boundary: ExplorationBoundaryDraft; session?: PolicySourceSession;
  coverage?: { report: PolicyCoverage; draft: ReturnType<typeof policyCoverageDraft> };
  confirmedMeanings?: ReadonlySet<string>;
}): ReadPrivacyReview {
  const digest = explorationBoundaryCandidateDigest(input.boundary);
  const source = activePolicySource(input.session);
  const meanings = input.confirmedMeanings ?? confirmedReadFieldMeanings(input.session, digest);
  let checked: PolicyCoverage | undefined;
  if (source && input.coverage) {
    const { report, draft } = input.coverage;
    // Coverage from another source, Action revision or Read revision cannot resolve this warning.
    if (report.source_digest === source.digest && report.draft_digest === canonicalJsonDigest(draft)
      && explorationBoundaryCandidateDigest(draft.read) === digest) {
      try { checked = parsePolicyCoverage({ passages: report.passages }, source, draft, input.session?.operator_messages?.join("\n") ?? ""); }
      catch { /* Keep advisory evidence, but do not claim a checked business meaning. */ }
    }
  }
  const catalog = readBoundaryRevisionCatalog(input.boundary);
  const findings = catalog.resources.flatMap((resource) => resource.fields.flatMap((field): Finding[] => {
    const passages = checked?.passages.filter((passage) => passage.disposition !== "background"
      && passage.field_checks?.some((check) => check.resource === resource.id && check.field === field.id)) ?? [];
    const expectations = [...new Set(passages.flatMap((passage) => (passage.field_checks ?? [])
      .filter((check) => check.resource === resource.id && check.field === field.id).map((check) => check.expectation)))];
    const matches = (expectation: "private" | "business_visible") => expectation === "private"
      ? !field.raw_return && !field.model_operations.length : field.raw_return;
    const pending = passages.filter((passage) => ["needs_decision", "conflict", "unsupported"].includes(passage.disposition));
    const visible = passages.filter((passage) => ["implemented", "overridden"].includes(passage.disposition)
      && passage.field_checks?.some((check) => check.resource === resource.id && check.field === field.id && check.expectation === "business_visible"));
    const rawHint = field.raw_return && field.roles.length > 0;
    const hiddenAnalysis = !field.raw_return && field.model_operations.length > 0;
    if (!rawHint && !hiddenAnalysis && !pending.length) return [];
    const recorded = field.raw_return && meanings.has(`${resource.id}.${field.id}`);
    // A passage may mix satisfied display/private fields with an unrelated conflict.
    // Compare its exact field expectations, without resolving the passage itself.
    const status = expectations.length > 1 || pending.length && expectations.some((expectation) => !matches(expectation))
      ? "policy_decision" : pending.length ? "field_access_matches" : field.raw_return && (recorded || visible.length)
      ? "business_meaning_checked" : "advisory";
    return [{ resource: resource.id, field: field.id,
      label: `${resource.label ?? resource.id.split(".").at(-1)!.replaceAll("_", " ")} / ${field.label ?? field.id.replaceAll("_", " ")}`,
      raw: field.raw_return, analysis: [...field.model_operations], roles: [...field.roles], status,
      evidence: [
        ...expectations.map((expectation) => `Expected access: ${expectation}. Current access ${matches(expectation) ? "matches" : "differs from"} this recorded field expectation.`),
        ...(expectations.length > 1 ? ["Recorded field expectations conflict with each other; a matching check does not settle the opposing requirement."] : []),
        ...(pending.length ? ["The attached-rule passage remains unresolved. This access comparison is not a confirmed business meaning or a policy waiver."] : []),
        ...(recorded ? ["Recorded operator meaning matches this exact Read revision: intentionally customer-facing."] : []),
        ...[...pending, ...visible].map((passage) => `Checked attached-rule interpretation, lines ${passage.start}-${passage.end}: ${passage.interpretation}`),
        ...(status === "advisory" ? ["A structural or naming hint is not proof of a privacy violation. No applicable business meaning is verified here."] : []),
      ],
    }];
  }));
  const visibleFields = new Set(checked?.passages.flatMap((passage) => passage.disposition !== "background"
    ? (passage.field_checks ?? []).filter((field) => field.expectation === "business_visible").map((field) => `${field.resource}.${field.field}`) : []));
  const privateFields = new Set(checked?.passages.flatMap((passage) =>
    passage.disposition !== "background"
      ? (passage.field_checks ?? []).filter((field) => field.expectation === "private").map((field) => `${field.resource}.${field.field}`) : []));
  const checkedFields = catalog.resources.flatMap((resource) =>
    resource.fields.filter((field) => privateFields.has(`${resource.id}.${field.id}`) && !visibleFields.has(`${resource.id}.${field.id}`)
      && !field.raw_return && !field.model_operations.length));
  const checkedPrivateFields = checkedFields.length;
  const checkedPrivateGroups = [...new Set(checkedFields.map((field) =>
    field.roles.some((role) => ["record_identity", "relationship_key", "trusted_scope"].includes(role)) ? "record identifiers"
      : field.roles.includes("conflict_or_version_guard") ? "internal revision markers"
      : "other policy-private information"))];
  return { digest, coverage: checked ? "current" : source ? "unavailable" : "not_attached", findings,
    ...(checked ? { checkedPrivateFields, checkedPrivateGroups,
      passageConcerns: unresolvedPolicyPassages(checked).filter((passage) => passage.field_checks?.length || referencesReadPolicy(passage))
        .map((passage) => ({ start: passage.start, end: passage.end, interpretation: passage.interpretation,
          hasFieldChecks: Boolean(passage.field_checks?.length) })),
    } : {}) };
}

export function readPrivacyFindingLines(finding: Finding): string[] {
  return [
    `${finding.label} (${finding.resource}.${finding.field})`,
    `Status: ${finding.status === "business_meaning_checked" ? "business meaning checked; no access change needed"
      : finding.status === "field_access_matches" ? "field access matches recorded expectation; passage remains unresolved"
      : finding.status === "policy_decision" ? "unresolved field expectation or access mismatch" : "advisory, not a proven policy violation"}`,
    `Agent receives values: ${finding.raw ? "yes" : "no"}. Model analysis: ${finding.analysis.join(", ") || "none"}.`,
    `Reason for flagging: ${finding.roles.join(", ") || (finding.raw ? "field values are returned"
      : finding.analysis.length ? "analysis of hidden values" : "recorded field expectation; no returned values or model analysis")}.`,
    ...finding.evidence,
  ];
}

export function readPrivacyPassageConcernLines(review: ReadPrivacyReview): string[] {
  return (review.passageConcerns ?? []).map((passage) => `Unresolved Read passage, lines ${passage.start}-${passage.end}: ${passage.interpretation} ${passage.hasFieldChecks
    ? "Field comparisons above do not settle the entire passage."
    : "No field-specific expectation supplied; not counted as a field failure."}`);
}

export function readPrivacySummary(review: ReadPrivacyReview): string[] {
  const decisions = review.findings.filter((finding) => finding.status === "policy_decision");
  const advisory = review.findings.filter((finding) => finding.status === "advisory");
  const matching = review.findings.filter((finding) => finding.status === "field_access_matches");
  const checked = review.findings.filter((finding) => finding.status === "business_meaning_checked");
  const named = (findings: Finding[]) => findings.length <= 3 ? findings.map((finding) => finding.label).join("; ")
    : `${findings.length} fields; Inspect privacy findings lists each one directly`;
  return [
    ...(review.checkedPrivateFields ? [`Policy-private information: ${review.checkedPrivateFields} checked field${review.checkedPrivateFields === 1 ? "" : "s"} (${review.checkedPrivateGroups?.join(", ") ?? "private fields"}) unavailable to customer viewing AND analysis, including filtering, sorting and aggregates. Exact details identifies each checked field.`] : []),
    ...(decisions.length ? [`Privacy decision: ${named(decisions)}. Compare the recorded field expectations and actual access; this is not a count of proven policy violations.`] : []),
    ...(advisory.length ? [`Privacy advisory: ${named(advisory)}. Inspect privacy findings for the exact access and reason; a hint is not a policy violation.`] : []),
    ...(matching.length ? [`Field access matches recorded expectations: ${named(matching)}. This does not resolve the wider attached-rule passages.`] : []),
    ...(checked.length ? [`Confirmed meaning: ${named(checked)} is customer-visible, as you requested. Access is unchanged.`] : []),
    ...(review.passageConcerns?.length ? [`Unresolved Read passages: ${review.passageConcerns.length}. Inspect privacy findings for every concern, also available under View exact Read Boundary details.`] : []),
    ...(review.coverage === "unavailable" ? ["Privacy evidence: attached-rule verification is unavailable for this exact revision. Recorded meanings do not settle other requirements."] : []),
  ];
}

/** Only affected reviewed metadata, never row values, identity values, or the full candidate. */
export function readPrivacyExplanationFacts(review: ReadPrivacyReview): string[] {
  const facts = ["Privacy evidence for the unchanged pending Read revision:"];
  const satisfied = (finding: Finding) => ["business_meaning_checked", "field_access_matches"].includes(finding.status);
  const ordered = [...review.findings].sort((a, b) => Number(satisfied(a)) - Number(satisfied(b)));
  // Bound model context independently of the complete, local operator view.
  for (const lines of [...readPrivacySummary(review).map((line) => [line]), ...ordered.map(readPrivacyFindingLines),
    ...readPrivacyPassageConcernLines(review).map((line) => [line])]) {
    if (Buffer.byteLength([...facts, ...lines].join("\n")) > 23_500) {
      facts.push("Additional findings are in Inspect privacy findings. Do not guess a field whose evidence is not included.");
      break;
    }
    facts.push(...lines);
  }
  facts.push("This inspection changes no draft or authority. Business-meaning reconciliation is not a blanket claim of safety or an activation decision.");
  return facts;
}

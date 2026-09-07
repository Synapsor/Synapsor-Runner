import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { readBoundaryRevisionCatalog } from "./read-boundary-revision-model.js";
import { activePolicySource, confirmedReadFieldMeanings, type PolicyCoverage, type PolicySourceSession } from "./authoring-policy-source.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import type { policyCoverageDraft } from "./authoring-policy-evidence.js";

type Finding = {
  resource: string; field: string; label: string; raw: boolean; analysis: string[]; roles: string[];
  status: "advisory" | "business_meaning_checked" | "policy_decision";
  evidence: string[];
};
export type ReadPrivacyReview = {
  digest: string; coverage: "current" | "unavailable" | "not_attached";
  findings: Finding[];
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
  const findings = readBoundaryRevisionCatalog(input.boundary).resources.flatMap((resource) => resource.fields.flatMap((field): Finding[] => {
    const passages = checked?.passages.filter((passage) => passage.field_checks?.some((check) => check.resource === resource.id && check.field === field.id)) ?? [];
    const pending = passages.filter((passage) => ["needs_decision", "conflict", "unsupported"].includes(passage.disposition));
    const visible = passages.filter((passage) => ["implemented", "overridden"].includes(passage.disposition)
      && passage.field_checks?.some((check) => check.resource === resource.id && check.field === field.id && check.expectation === "business_visible"));
    const rawHint = field.raw_return && field.roles.length > 0;
    const hiddenAnalysis = !field.raw_return && field.model_operations.length > 0;
    if (!rawHint && !hiddenAnalysis && !pending.length) return [];
    const recorded = field.raw_return && meanings.has(`${resource.id}.${field.id}`);
    const status = pending.length ? "policy_decision" : field.raw_return && (recorded || visible.length)
      ? "business_meaning_checked" : "advisory";
    return [{ resource: resource.id, field: field.id,
      label: `${resource.label ?? resource.id.split(".").at(-1)!.replaceAll("_", " ")} / ${field.label ?? field.id.replaceAll("_", " ")}`,
      raw: field.raw_return, analysis: [...field.model_operations], roles: [...field.roles], status,
      evidence: [
        ...(recorded ? ["Recorded operator meaning matches this exact Read revision: intentionally customer-facing."] : []),
        ...[...pending, ...visible].map((passage) => `Checked attached-rule interpretation, lines ${passage.start}-${passage.end}: ${passage.interpretation}`),
        ...(status === "advisory" ? ["A structural or naming hint is not proof of a privacy violation. No applicable business meaning is verified here."] : []),
      ],
    }];
  }));
  return { digest, coverage: checked ? "current" : source ? "unavailable" : "not_attached", findings };
}

export function readPrivacyFindingLines(finding: Finding): string[] {
  return [
    `${finding.label} (${finding.resource}.${finding.field})`,
    `Status: ${finding.status === "business_meaning_checked" ? "business meaning checked; no access change needed"
      : finding.status === "policy_decision" ? "unresolved policy requirement" : "advisory, not a proven policy violation"}`,
    `Agent receives values: ${finding.raw ? "yes" : "no"}. Model analysis: ${finding.analysis.join(", ") || "none"}.`,
    `Reason for flagging: ${finding.roles.join(", ") || "analysis of hidden values"}.`,
    ...finding.evidence,
  ];
}

export function readPrivacySummary(review: ReadPrivacyReview): string[] {
  const pending = review.findings.filter((finding) => finding.status !== "business_meaning_checked");
  const checked = review.findings.filter((finding) => finding.status === "business_meaning_checked");
  const named = (findings: Finding[]) => findings.length <= 3 ? findings.map((finding) => finding.label).join("; ")
    : `${findings.length} fields; Inspect privacy findings lists each one directly`;
  return [
    ...(pending.length ? [`${pending.some((finding) => finding.status === "policy_decision") ? "Privacy decision" : "Privacy advisory"}: ${named(pending)}. Inspect privacy findings for the exact access and reason${pending.some((finding) => finding.status === "policy_decision") ? "." : "; a hint is not a policy violation."}`] : []),
    ...(checked.length ? [`Confirmed meaning: ${named(checked)} is customer-visible, as you requested. Access is unchanged.`] : []),
    ...(review.coverage === "unavailable" ? ["Privacy evidence: attached-rule verification is unavailable for this exact revision. Recorded meanings do not settle other requirements."] : []),
  ];
}

/** Only affected reviewed metadata, never row values, identity values, or the full candidate. */
export function readPrivacyExplanationFacts(review: ReadPrivacyReview): string[] {
  const facts = ["Privacy evidence for the unchanged pending Read revision:", ...readPrivacySummary(review)];
  const ordered = [...review.findings].sort((a, b) => Number(a.status === "business_meaning_checked") - Number(b.status === "business_meaning_checked"));
  // Bound model context independently of the complete, local operator view.
  for (const finding of ordered) {
    const lines = readPrivacyFindingLines(finding);
    if (Buffer.byteLength([...facts, ...lines].join("\n")) > 24_000) {
      facts.push("Additional findings are in Inspect privacy findings. Do not guess a field whose evidence is not included.");
      break;
    }
    facts.push(...lines);
  }
  facts.push("This inspection changes no draft or authority. Business-meaning reconciliation is not a blanket claim of safety or an activation decision.");
  return facts;
}

import { EXPLORATION_PRESENCE_MEASURE_FUNCTIONS, type ExplorationBoundaryDraft, type ExplorationDerivedBaseMeasure } from "./auto-boundary.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readBoundaryRevisionCatalog, reviewedModelAnalysisOperations } from "./read-boundary-revision-model.js";
import { readPrivacyReview, readPrivacyFindingLines, readPrivacyPassageConcernLines, readPrivacySummary, type ReadPrivacyReview } from "./read-boundary-privacy-review.js";

import type { ReviewSection, ReadChangeCounts } from "./read-boundary-review-types.js";
export type { ReviewSection } from "./read-boundary-review-types.js";
type Resource = ExplorationBoundaryDraft["pack"]["resources"][number];

const diffPath = (root: string) => path.join(root, ".synapsor", "boundary-authoring", "read-review-diff.json");

export async function saveReadReviewDiff(root: string, digest: string, section: ReviewSection): Promise<void> {
  const destination = diffPath(root), temporary = `${destination}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ format_version: 2, digest, section }), { mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

export async function loadReadReviewDiff(root: string, digest: string): Promise<ReviewSection | undefined> {
  try {
    if ((await fs.stat(diffPath(root))).size > 2 * 1024 * 1024) return undefined;
    const value: unknown = JSON.parse(await fs.readFile(diffPath(root), "utf8"));
    if (!value || typeof value !== "object" || !("format_version" in value) || value.format_version !== 2
      || !("digest" in value) || value.digest !== digest || !("section" in value)) return undefined;
    const valid = (node: unknown, depth: number): node is ReviewSection => Boolean(node && typeof node === "object"
      && "id" in node && typeof node.id === "string" && "title" in node && typeof node.title === "string"
      && "lines" in node && Array.isArray(node.lines) && node.lines.every((line) => typeof line === "string")
      && (!("children" in node) || depth < 3 && Array.isArray(node.children) && node.children.every((child) => valid(child, depth + 1))));
    return valid(value.section, 0) ? value.section : undefined;
  } catch { return undefined; } // Optional presentation artifact; never authorizes anything.
}

export function fieldAccess(resource: Resource, field: string): string {
  if (resource.kept_out_fields.includes(field)) return "KEPT OUT";
  if (resource.model_withheld_fields?.includes(field)) return "RUNNER ONLY";
  return resource.selectable_fields.includes(field) ? "MODEL RAW" : "NO RAW RETURN";
}

export function fieldPermissions(resource: Resource, field: string) {
  const excluded = resource.kept_out_fields.includes(field);
  const selection = !excluded && resource.selectable_fields.includes(field);
  return { raw: selection && !resource.model_withheld_fields?.includes(field), selection, excluded,
    withheld: resource.model_withheld_fields?.includes(field) ?? false,
    analysis: reviewedModelAnalysisOperations(resource, field) };
}

function reviewedMeasureReference(measure: ExplorationDerivedBaseMeasure): string {
  return "field" in measure
    ? `${measure.function}(${measure.relationship ? `relationship ${JSON.stringify(measure.relationship)}, ` : ""}field ${JSON.stringify(measure.field)})`
    : "count()";
}

// Keep logical facts unwrapped; the existing read-only pager reflows on resize.
function resourcePermissionOverview(resource: Resource): string[] {
  const fields = Object.keys(resource.field_types).sort();
  return [
    `Complete field permissions: ${fields.length} fields. Raw exposure and analysis grants are independent.`,
    ...fields.flatMap((field) => {
      const permissions = fieldPermissions(resource, field), label = resource.field_metadata?.[field]?.label;
      return ["", `Field: ${field}${label ? ` (${label})` : ""}`,
        `Raw access: ${fieldAccess(resource, field)}`,
        `Runner row selection: ${permissions.selection ? "yes" : "no"}`,
        `Model-invocable analysis: ${permissions.analysis.join(", ") || "none"}`,
        ...(permissions.analysis.includes("presence") ? [`Presence functions: ${EXPLORATION_PRESENCE_MEASURE_FUNCTIONS.join(", ")}`] : []),
        `Reviewed value allowlist: ${resource.field_enums[field]?.map((value) => JSON.stringify(value)).join(", ") || "none"}`,
      ];
    }),
    "", "REVIEWED ANALYSIS DEFINITIONS",
    ...((resource.derived_measures?.length ?? 0) ? resource.derived_measures!.flatMap((measure) => [
      `Derived measure: ${measure.name} (${measure.label})`, `Shape: ${measure.shape}`,
      ...("numerator" in measure ? [`Numerator: ${reviewedMeasureReference(measure.numerator)}`,
        `Denominator: ${reviewedMeasureReference(measure.denominator)}`, `Null policy: ${measure.null_policy}`] : []),
      ...("base_measure" in measure ? [`Base measure: ${reviewedMeasureReference(measure.base_measure)}`,
        ...(measure.direction !== undefined ? [`Direction: ${measure.direction}`] : []),
        ...(measure.window_size !== undefined ? [`Window size: ${measure.window_size}`] : [])] : []),
      ...("child_resource" in measure ? [`Child resource: ${measure.child_resource}`, `Relationship: ${measure.relationship}`] : []),
      "",
    ]) : ["Derived measures: none"]),
    ...((resource.numeric_bands?.length ?? 0) ? resource.numeric_bands!.flatMap((band) => [
      `Numeric band: ${band.name} (${band.label})`,
      `Field reference: ${band.relationship ? `relationship ${JSON.stringify(band.relationship)}, ` : ""}field ${JSON.stringify(band.field)}`,
      `Edges: ${band.edges.join(", ")}`, `Bucket labels: ${band.bucket_labels.map((label) => JSON.stringify(label)).join(", ")}`, "",
    ]) : ["Numeric bands: none"]),
    ...((resource.auto_bands?.length ?? 0) ? resource.auto_bands!.flatMap((band) => [
      `Auto band field: ${band.field}`, `Methods: ${band.methods.join(", ")}`,
      `Bucket count: ${band.min_buckets} to ${band.max_buckets}`,
      ...(band.min_bucket_width !== undefined ? [`Minimum bucket width: ${band.min_bucket_width}`] : []),
      `Label style: ${band.label_style}`,
      ...(band.label_round_to !== undefined ? [`Label rounding: ${band.label_round_to}`] : []), "",
    ]) : ["Auto bands: none"]),
    `End of ${resource.id}: all ${fields.length} fields and reviewed analysis definitions shown.`,
  ];
}

export function findReviewSection(sections: ReviewSection[], id: string): ReviewSection | undefined {
  for (const section of sections) {
    if (section.id === id) return section;
    const child = findReviewSection(section.children ?? [], id);
    if (child) return child;
  }
  return undefined;
}

export function reviewSectionLines(section: ReviewSection): string[] {
  return [section.title, ...section.lines, ...(section.children ?? []).flatMap(reviewSectionLines)];
}

export function readRevisionDiff(
  before: ExplorationBoundaryDraft, after: ExplorationBoundaryDraft,
  reasons: Array<{ resource: string; field: string; rationale?: string }> = [],
): ReviewSection {
  const groups: Record<string, ReviewSection[]> = { reductions: [], expansions: [], private: [], exclusions: [], representation: [], other: [] };
  const counts: ReadChangeCounts = { fields: 0, permissions: 0, rawRemoved: 0, analysisRemoved: 0,
    rawAdded: 0, analysisAdded: 0, selectionAdded: 0, selectionRemoved: 0, exclusions: 0, representation: 0, other: 0 };
  const hidden: string[] = [], analysisRestricted: string[] = [], privateAdded: string[] = [];
  let exclusionsOpenedForSelection = 0;
  const prerequisiteChanged = canonicalJsonDigest(before.read_prerequisite ?? null) !== canonicalJsonDigest(after.read_prerequisite ?? null);
  if (prerequisiteChanged) {
    counts.other++;
    groups.other!.push({ id: "private_access_condition", title: "Private access condition changed", lines: [
      "Before:", ...JSON.stringify(before.read_prerequisite ?? null, null, 2).split("\n"),
      "After:", ...JSON.stringify(after.read_prerequisite ?? null, null, 2).split("\n"),
      "These are private verification permissions, not customer-readable fields. Every data query checks current evidence before returning records or analysis.",
    ] });
  }
  for (const resource of after.pack.resources) {
    const previous = before.pack.resources.find((item) => item.id === resource.id);
    if (!previous) continue;
    for (const field of Object.keys(resource.field_types).sort()) {
      const oldAccess = fieldAccess(previous, field), newAccess = fieldAccess(resource, field);
      const old = fieldPermissions(previous, field), next = fieldPermissions(resource, field);
      const oldOps = old.analysis, newOps = next.analysis;
      const removed = oldOps.filter((op) => !newOps.includes(op));
      const added = newOps.filter((op) => !oldOps.includes(op));
      const rawChanged = old.raw !== next.raw, selectionChanged = old.selection !== next.selection;
      const excludedChanged = old.excluded !== next.excluded;
      const permissions = Number(rawChanged) + Number(selectionChanged) + Number(excludedChanged) + removed.length + added.length;
      if (!permissions && old.withheld === next.withheld) continue;
      counts.fields += 1;
      counts.permissions += permissions;
      counts.rawRemoved += Number(old.raw && !next.raw);
      counts.rawAdded += Number(!old.raw && next.raw);
      counts.analysisRemoved += removed.length;
      counts.analysisAdded += added.length;
      counts.selectionAdded += Number(!old.selection && next.selection);
      counts.selectionRemoved += Number(old.selection && !next.selection);
      counts.exclusions += Number(excludedChanged);
      counts.representation += Number(!permissions);
      const meaning = resource.field_metadata?.[field]?.label;
      const namedField = `${resource.id}.${field}${meaning ? ` (${meaning})` : ""}`;
      if (old.raw && !next.raw) hidden.push(namedField);
      else if (removed.length) analysisRestricted.push(namedField);
      if (!old.selection && next.selection && !next.raw) privateAdded.push(namedField);
      if (old.excluded && !next.excluded && !old.selection && next.selection) exclusionsOpenedForSelection++;
      const labels = [
        ...(rawChanged ? [next.raw ? "agent can see values" : "values hidden from agent"] : []),
        ...(removed.length ? [`${removed.length} analysis permissions removed`] : []),
        ...(added.length ? [`${added.length} analysis permissions added`] : []),
        ...(selectionChanged ? [next.selection ? "new Runner row selection" : "Runner row selection removed"] : []),
        ...(excludedChanged ? [next.excluded ? "field excluded" : "exclusion removed"] : []),
        ...(!permissions ? ["classification only; access unchanged"] : []),
      ];
      const group = next.raw && !old.raw || added.length ? "expansions"
        : old.raw && !next.raw || removed.length ? "reductions" : selectionChanged ? "private"
          : excludedChanged ? "exclusions" : "representation";
      groups[group]!.push({ id: `${resource.id}.${field}`, title: `${resource.id}.${field}: ${labels.join("; ")}`,
        lines: [
          ...(!old.selection && next.selection && !next.raw
            ? ["The agent sees no additional values. Runner gains permission to read previously unavailable information; necessity has not been established by this diff."] : []),
          `Change: ${labels.join("; ")}.`,
          `Agent receives actual values: ${old.raw ? "yes" : "no"} -> ${next.raw ? "yes" : "no"}`,
          `Model analysis before: ${oldOps.join(", ") || "none"}`,
          `Model analysis after: ${newOps.join(", ") || "none"}`,
          `Runner row selection: ${old.selection ? "allowed" : "not allowed"} -> ${next.selection ? "allowed" : "not allowed"}`,
          `Kept out: ${old.excluded ? "yes" : "no"} -> ${next.excluded ? "yes" : "no"}`,
          `Raw-withholding marker: ${old.withheld ? "yes" : "no"} -> ${next.withheld ? "yes" : "no"}`,
          `Display classification: ${oldAccess} -> ${newAccess} (not itself a permission)`,
          ...(!old.selection && next.selection ? ["NEW ACCESS: Runner can now select this field through Read queries; this is an access expansion, not a privacy reduction."] : []),
          ...(!old.raw && next.raw ? ["NEW ACCESS: raw values may now be returned to the model."] : []),
          "Private reference/conflict verification is controlled separately by the Action Boundary; row-selection changes do not prove a new verification requirement.",
          ...(field === resource.primary_key ? ["Reviewed row identity: used privately for opaque references when required by an Action; no model-supplied identity."] : []),
          `Model-proposed rationale (not proof of a runtime role): ${reasons.find((reason) => reason.resource === resource.id && reason.field === field)?.rationale ?? "Requested privacy/operation change."}`,
        ] });
    }
    for (const key of ["derived_measures", "numeric_bands", "auto_bands", "relationships"] as const) {
      if (JSON.stringify(previous[key] ?? []) !== JSON.stringify(resource[key] ?? [])) {
        counts.other += 1;
        groups.other!.push({ id: `${resource.id}:${key}`, title: `${resource.id}: ${key} changed`, lines: [
          "Before:", ...JSON.stringify(previous[key] ?? [], null, 2).split("\n"),
          "After:", ...JSON.stringify(resource[key] ?? [], null, 2).split("\n"),
        ] });
      }
    }
  }
  const titles: Record<string, string> = { reductions: "Less information available to the agent", expansions: "More information available to the agent",
    private: "Runner row-selection changes", exclusions: "Field exclusions", representation: "Classification only (access unchanged)", other: "Other query/relationship changes" };
  return { id: "changes", title: "Changes only", changeCounts: counts, lines: [
    ...(prerequisiteChanged ? [after.read_prerequisite
      ? "Access condition: check the reviewed current status before every data query. Missing, inactive or expired evidence denies access. Runner gains this private verification permission only after activation."
      : "Access condition removed: the previous current-status check would no longer protect reads. Review this change before activation."] : []),
    ...(hidden.length ? [hidden.length <= 4 ? `Hidden from the agent: ${hidden.join(", ")}.`
      : `Hidden from the agent: ${hidden.length} fields. Open Less information available to the agent for the complete list.`] : []),
    ...(analysisRestricted.length ? [analysisRestricted.length <= 4 ? `Fewer ways to query information: ${analysisRestricted.join(", ")}. Exact changes list the removed analysis permissions.`
      : `Analysis restricted for ${analysisRestricted.length} fields. Open Less information available to the agent for the complete list.`] : []),
    ...(counts.rawAdded || counts.analysisAdded ? [`Additional agent access: ${counts.rawAdded} newly visible fields; ${counts.analysisAdded} new ways to query information. Review More information available to the agent.`] : []),
    ...(privateAdded.length ? [`Additional private Read access: ${privateAdded.length} fields${privateAdded.length <= 3 ? ` (${privateAdded.join(", ")})` : "; open Runner row-selection changes"}. This requires a separate reason; scope filtering and Action verification alone do not require it.`] : []),
    ...(exclusionsOpenedForSelection ? [`Existing exclusions removed for ${exclusionsOpenedForSelection} of these same newly readable fields, not ${exclusionsOpenedForSelection} additional fields.`] : []),
    ...(!counts.selectionAdded && !counts.rawAdded && !counts.analysisAdded && !prerequisiteChanged ? ["No new information becomes readable by Runner or the agent."] : []),
    ...(counts.selectionRemoved ? [`Runner can no longer select ${counts.selectionRemoved} fields.`] : []),
    ...(counts.other ? [`Related query settings changed: ${counts.other}; inspect Other query/relationship changes.`] : []),
    ...(counts.representation && !counts.permissions ? ["Classification only; effective access is unchanged."] : []),
    "Save changes only this disabled draft; active permissions are unchanged.",
  ], children: Object.entries(groups).filter(([, entries]) => entries.length).map(([id, entries]) => ({
    id, title: `${titles[id]} (${entries.length})`, lines: [`${entries.length} changed field/settings entries. Select one to compare its exact permissions.`], children: entries,
  })) };
}

export function readBoundaryReviewSections(input: {
  boundary: ExplorationBoundaryDraft; digest: string; changes?: ReviewSection; privateDependencies?: string[]; privacy?: ReadPrivacyReview;
}): ReviewSection[] {
  const { boundary } = input;
  const privacy = input.privacy ?? readPrivacyReview({ boundary });
  const catalog = readBoundaryRevisionCatalog(boundary);
  const resources = boundary.pack.resources.map((resource): ReviewSection => {
    const fields = catalog.resources.find((item) => item.id === resource.id)!.fields;
    const counts = ["MODEL RAW", "RUNNER ONLY", "KEPT OUT", "NO RAW RETURN"].map((access) =>
      `${Object.keys(resource.field_types).filter((field) => fieldAccess(resource, field) === access).length} ${access.toLowerCase()}`);
    return { id: resource.id, title: `${resource.label ? `${resource.label} (${resource.id})` : resource.id} | ${counts.join(" / ")}`,
      lines: [counts.join(" | "), ...(resource.description ? [resource.description] : []),
        ...resourcePermissionOverview(resource)],
      children: [
        ...fields.map((field): ReviewSection => {
          const ops = reviewedModelAnalysisOperations(resource, field.id);
          const access = fieldAccess(resource, field.id);
          const change = findReviewSection(input.changes?.children ?? [], `${resource.id}.${field.id}`);
          return { id: field.id, title: `${field.id} | ${access}${ops.length ? ` | ${ops.length} analysis grants` : ""}`, lines: [
            ...(field.label ? [`Label: ${field.label}`] : []), ...(field.description ? [`Description: ${field.description}`] : []),
            `Database type: ${field.type}`, `Raw access: ${access}`,
            `Runner row selection: ${fieldPermissions(resource, field.id).selection ? "allowed" : "not allowed"}`,
            `Model-invocable analysis: ${ops.join(", ") || "none"}`,
            ...(access === "RUNNER ONLY" ? [
              fieldPermissions(resource, field.id).selection
                ? "Return value: Runner can select values locally; model output withholds/tokenizes them. No raw model return."
                : "No Read row-selection grant. A withholding marker alone does not allow Runner to select this field.",
              ops.length ? "PRIVACY REVIEW: these analysis grants can reveal information despite raw withholding. Review privacy to remove them, or intentionally retain analysis."
                : "No field filters, sorting, grouping or aggregate inference grants. Private verification and opaque references require their separately reviewed Action dependencies.",
            ] : []),
            ...(access === "NO RAW RETURN" ? ["Model + Runner classification alone does not grant retrieval. Only the operations listed above are available."] : []),
            `Structural roles/hints: ${field.roles.join(", ") || "none proven; review business meaning if ambiguous"}`,
            ...(field.roles.some((role) => role.endsWith("candidate") || role === "conflict_or_version_guard")
              ? ["Naming hints are not proof that a business field is private or used as a conflict guard. Review metadata and Action dependencies."] : []),
            `Reviewed value allowlist: ${JSON.stringify(resource.field_enums[field.id] ?? [])}`,
            `Numeric aggregate functions: ${JSON.stringify(resource.aggregate_measure_functions?.[field.id] ?? [])}`,
            ...(change?.lines.filter((line) => line.startsWith("Model-proposed rationale")) ?? []),
          ] };
        }),
        { id: "resource_settings", title: "Resource settings and Read relationships", lines: JSON.stringify({
          minimum_cohort_size: resource.minimum_cohort_size, relationships: resource.relationships,
          derived_measures: resource.derived_measures, numeric_bands: resource.numeric_bands, auto_bands: resource.auto_bands,
          tenant_key: resource.tenant_key, principal_key: resource.principal_key,
          tenant_scope: resource.tenant_scope, principal_scope: resource.principal_scope,
          rls_session: resource.rls_session, shared_reference_scope: resource.shared_reference_scope,
        }, null, 2).split("\n") },
      ] };
  });
  return [
    { id: "privacy_findings", title: "Privacy findings and recorded meanings", lines: [
      ...readPrivacySummary(privacy),
      ...(!privacy.findings.length ? ["No advisory field findings in this revision. This is not a general certification of privacy."] : []),
      "Inspection only: no model request, permission change, or activation.",
      ...privacy.findings.flatMap((finding) => ["", ...readPrivacyFindingLines(finding)]),
      ...readPrivacyPassageConcernLines(privacy).flatMap((line) => ["", line]),
      `Exact fingerprint: ${input.digest}`,
    ] },
    { id: "resources", title: `Resources and fields (${resources.length})`, lines: [
      `Complete field permissions for all ${resources.length} reviewed resources. Labels do not grant access.`,
      ...resources.flatMap((resource) => ["", resource.title, ...resource.lines]),
    ], children: resources },
    input.changes ?? { id: "changes", title: "Changes only", lines: ["No prior revision comparison is attached to this review. Current exact authority remains available under Resources and Raw JSON."] },
    { id: "scope", title: "Scope, limits and fingerprint", lines: [
      "Read relationships serve customer queries; zero Read links does not mean private Action verification has no links.",
      ...JSON.stringify({ trusted_context: boundary.trusted_context, organization_scope: boundary.organization_scope,
        budgets: boundary.budgets, scope: boundary.pack.resources.map((resource) => ({ resource: resource.id,
          tenant_key: resource.tenant_key, principal_key: resource.principal_key, tenant_scope: resource.tenant_scope,
          principal_scope: resource.principal_scope, rls_session: resource.rls_session, shared_reference_scope: resource.shared_reference_scope,
        })) }, null, 2).split("\n"), `Exact fingerprint: ${input.digest}`,
    ] },
    ...(boundary.read_prerequisite ? [{ id: "private_access_condition", title: "Private access condition", lines: [
      `Evidence meaning: ${boundary.read_prerequisite.semantic_consent.source_description}`,
      `Positive condition: ${boundary.read_prerequisite.semantic_consent.positive_state_description}`,
      "Every data query, including counts and analysis, requires matching trusted identity, the reviewed positive status and a currently effective interval.",
      "Missing, negative, not-yet-effective or expired evidence denies access. The private check does not add a customer-readable resource or permit source changes.",
      "Exact status, dates, scope and inspected dependency:", ...JSON.stringify(boundary.read_prerequisite, null, 2).split("\n"),
      `Exact Read fingerprint: ${input.digest}`,
    ] }] : []),
    { id: "dependencies", title: "Private Action verification dependencies", lines: input.privateDependencies ?? ["No dependent Action record is attached to this Read-only review. No Action authority is granted here."] },
    { id: "json", title: "Raw JSON (complete reviewed revision)", lines: [
      "This is the candidate document, not the activation ledger. disabled_unreviewed means it grants no active authority; reviewed readiness and explicit activation are tracked separately.",
      `Exact fingerprint: ${input.digest}`, ...JSON.stringify(boundary, null, 2).split("\n"),
    ] },
  ];
}

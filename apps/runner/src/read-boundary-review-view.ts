import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readBoundaryRevisionCatalog, reviewedModelAnalysisOperations } from "./read-boundary-revision-model.js";

export type ReviewSection = { id: string; title: string; lines: string[]; children?: ReviewSection[] };
type Resource = ExplorationBoundaryDraft["pack"]["resources"][number];

const diffPath = (root: string) => path.join(root, ".synapsor", "boundary-authoring", "read-review-diff.json");

export async function saveReadReviewDiff(root: string, digest: string, section: ReviewSection): Promise<void> {
  const destination = diffPath(root), temporary = `${destination}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ digest, section }), { mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

export async function loadReadReviewDiff(root: string, digest: string): Promise<ReviewSection | undefined> {
  try {
    if ((await fs.stat(diffPath(root))).size > 2 * 1024 * 1024) return undefined;
    const value: unknown = JSON.parse(await fs.readFile(diffPath(root), "utf8"));
    if (!value || typeof value !== "object" || !("digest" in value) || value.digest !== digest || !("section" in value)) return undefined;
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

export function readRevisionDiff(
  before: ExplorationBoundaryDraft, after: ExplorationBoundaryDraft,
  reasons: Array<{ resource: string; field: string; rationale?: string }> = [],
): ReviewSection {
  const children: ReviewSection[] = [];
  let permissionChanges = 0, changedFields = 0;
  for (const resource of after.pack.resources) {
    const previous = before.pack.resources.find((item) => item.id === resource.id);
    if (!previous) continue;
    for (const field of Object.keys(resource.field_types).sort()) {
      const oldAccess = fieldAccess(previous, field), newAccess = fieldAccess(resource, field);
      const oldOps = reviewedModelAnalysisOperations(previous, field), newOps = reviewedModelAnalysisOperations(resource, field);
      const removed = oldOps.filter((op) => !newOps.includes(op));
      const added = newOps.filter((op) => !oldOps.includes(op));
      if (oldAccess === newAccess && !removed.length && !added.length) continue;
      changedFields += 1;
      permissionChanges += Number(oldAccess !== newAccess) + removed.length + added.length;
      children.push({ id: `${resource.id}.${field}`, title: `${resource.id}.${field}: ${oldAccess} -> ${newAccess}`,
        lines: [
          `Raw access: ${oldAccess} -> ${newAccess}`,
          `Model analysis before: ${oldOps.join(", ") || "none"}`,
          `Model analysis after: ${newOps.join(", ") || "none"}`,
          ...(oldAccess === "KEPT OUT" && newAccess !== "KEPT OUT" ? [
            newAccess === "RUNNER ONLY"
              ? "NEW ACCESS: previously excluded; now available for reviewed private use. This is not merely hiding a value."
              : newAccess === "MODEL RAW"
                ? "NEW ACCESS: previously excluded; reviewed raw values may now be returned to the model."
                : "NEW ACCESS: previously excluded; the model analysis grants listed above are now available, without raw return.",
          ] : []),
          `Reason: ${reasons.find((reason) => reason.resource === resource.id && reason.field === field)?.rationale ?? "Requested reviewed privacy/operation change."}`,
        ] });
    }
    for (const key of ["derived_measures", "numeric_bands", "auto_bands", "relationships"] as const) {
      if (JSON.stringify(previous[key] ?? []) !== JSON.stringify(resource[key] ?? [])) {
        children.push({ id: `${resource.id}:${key}`, title: `${resource.id}: ${key} changed`, lines: [
          "Before:", ...JSON.stringify(previous[key] ?? [], null, 2).split("\n"),
          "After:", ...JSON.stringify(resource[key] ?? [], null, 2).split("\n"),
        ] });
      }
    }
  }
  return { id: "changes", title: "Changes only", lines: [
    `${changedFields} changed resource-qualified fields; ${permissionChanges} individual raw/analysis permission changes.`,
    "Counts are per resource + field, not deduplicated column names. Additional derived grants are listed separately.",
  ], children };
}

export function readBoundaryReviewSections(input: {
  boundary: ExplorationBoundaryDraft; digest: string; changes?: ReviewSection; privateDependencies?: string[];
}): ReviewSection[] {
  const { boundary } = input;
  const catalog = readBoundaryRevisionCatalog(boundary);
  const resources = boundary.pack.resources.map((resource): ReviewSection => {
    const fields = catalog.resources.find((item) => item.id === resource.id)!.fields;
    const counts = ["MODEL RAW", "RUNNER ONLY", "KEPT OUT", "NO RAW RETURN"].map((access) =>
      `${Object.keys(resource.field_types).filter((field) => fieldAccess(resource, field) === access).length} ${access.toLowerCase()}`);
    return { id: resource.id, title: `${resource.label ? `${resource.label} (${resource.id})` : resource.id} | ${counts.join(" / ")}`,
      lines: [counts.join(" | "), ...(resource.description ? [resource.description] : []),
        "Raw access and model analysis are separate. Select a field for its exact operations and rationale."],
      children: [
        ...fields.map((field): ReviewSection => {
          const ops = reviewedModelAnalysisOperations(resource, field.id);
          const access = fieldAccess(resource, field.id);
          const change = input.changes?.children?.find((item) => item.id === `${resource.id}.${field.id}`);
          return { id: field.id, title: `${field.id} | ${access}${ops.length ? ` | ${ops.length} analysis grants` : ""}`, lines: [
            ...(field.label ? [`Label: ${field.label}`] : []), ...(field.description ? [`Description: ${field.description}`] : []),
            `Database type: ${field.type}`, `Raw access: ${access}`,
            `Model-invocable analysis: ${ops.join(", ") || "none"}`,
            ...(access === "RUNNER ONLY" ? [
              "Return value: Runner retains raw values locally; model output withholds/tokenizes them. This is not permission for raw model return.",
              ops.length ? "PRIVACY REVIEW: these analysis grants can reveal information despite raw withholding. Review privacy to remove them, or intentionally retain analysis."
                : "No field filters, sorting, grouping or aggregate inference grants. Raw cell tokens do not reveal value equality. Private verification and opaque references remain available.",
            ] : []),
            ...(access === "NO RAW RETURN" ? ["Model + Runner classification alone does not grant retrieval. Only the operations listed above are available."] : []),
            `Structural roles/hints: ${field.roles.join(", ") || "none proven; review business meaning if ambiguous"}`,
            ...(field.roles.some((role) => role.endsWith("candidate") || role === "conflict_or_version_guard")
              ? ["Naming hints are not proof that a business field is private or used as a conflict guard. Review metadata and Action dependencies."] : []),
            `Reviewed value allowlist: ${JSON.stringify(resource.field_enums[field.id] ?? [])}`,
            `Numeric aggregate functions: ${JSON.stringify(resource.aggregate_measure_functions?.[field.id] ?? [])}`,
            ...(change?.lines.filter((line) => line.startsWith("Reason:")).map((line) => line.replace(/^Reason:/u, "Revision rationale:")) ?? []),
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
    { id: "resources", title: `Resources and fields (${resources.length})`, lines: ["Select a resource, then a field. All raw access and model analysis grants are shown separately."], children: resources },
    input.changes ?? { id: "changes", title: "Changes only", lines: ["No prior revision comparison is attached to this review. Current exact authority remains available under Resources and Raw JSON."] },
    { id: "scope", title: "Scope, limits and fingerprint", lines: [
      "Read relationships serve customer queries; zero Read links does not mean private Action verification has no links.",
      ...JSON.stringify({ trusted_context: boundary.trusted_context, organization_scope: boundary.organization_scope,
        budgets: boundary.budgets, scope: boundary.pack.resources.map((resource) => ({ resource: resource.id,
          tenant_key: resource.tenant_key, principal_key: resource.principal_key, tenant_scope: resource.tenant_scope,
          principal_scope: resource.principal_scope, rls_session: resource.rls_session, shared_reference_scope: resource.shared_reference_scope,
        })) }, null, 2).split("\n"), `Exact fingerprint: ${input.digest}`,
    ] },
    { id: "dependencies", title: "Private Action verification dependencies", lines: input.privateDependencies ?? ["No dependent Action record is attached to this Read-only review. No Action authority is granted here."] },
    { id: "json", title: "Raw JSON (complete reviewed revision)", lines: [
      "This is the candidate document, not the activation ledger. disabled_unreviewed means it grants no active authority; reviewed readiness and explicit activation are tracked separately.",
      `Exact fingerprint: ${input.digest}`, ...JSON.stringify(boundary, null, 2).split("\n"),
    ] },
  ];
}

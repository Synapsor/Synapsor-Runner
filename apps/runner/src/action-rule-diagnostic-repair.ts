import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ACTION_RULE_MATH_GUIDANCE } from "@synapsor-runner/action-rules";
import type { RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";

export type ActionRuleRepairContext = {
  builtCatalog: BuiltActionRuleAuthoringCatalogV1;
  verification?: {
    name?: string;
    resources: Array<Pick<RuleVerificationBoundarySpecV1["resources"][number], "binding" | "resource" | "deterministic_order">>;
  };
};

export type ActionRuleDiagnosticRepair = {
  category: "draft_structure" | "source_evidence" | "concurrency" | "deployment" | "business_decision";
  next_action: string;
  correction?: {
    operation: "replace_deterministic_order";
    path: string;
    resource: string;
    binding: string;
    before: Array<{ field: string; direction: "asc" | "desc" }>;
    after: Array<{ field: string; direction: "asc" | "desc" }>;
    catalog_digest: string;
    authority_granted: false;
    requires_validation: true;
  };
};

/** Suggestions are evidence, not authority: callers must resubmit and compile. */
export function actionRuleDiagnosticRepair(
  diagnostic: { code: string; path?: string; message: string },
  context?: ActionRuleRepairContext,
): ActionRuleDiagnosticRepair {
  if (diagnostic.code === "ACTION_RULE_EXPRESSION_KIND_INVALID") {
    return { category: "draft_structure", next_action: ACTION_RULE_MATH_GUIDANCE };
  }
  const orderPath = /^verification_boundary\.resources\.([a-zA-Z_][a-zA-Z0-9_]*)\.deterministic_order$/u.exec(diagnostic.path ?? "");
  if (diagnostic.code === "ACTION_RULE_UNBOUNDED" && orderPath && context) {
    const binding = orderPath[1]!;
    const matches = context.verification?.resources.filter((entry) => entry.binding === binding) ?? [];
    const source = matches.length === 1 ? matches[0] : undefined;
    const candidates = context.builtCatalog.catalog.resources.filter((entry) => entry.name === source?.resource);
    const resource = candidates.length === 1 ? candidates[0] : undefined;
    const fields = new Set(resource?.fields.map((entry) => entry.name));
    const before = source?.deterministic_order ?? [];
    if (source && resource && fields.has(resource.primary_key) && before.length < 8
      && new Set(before.map((entry) => entry.field)).size === before.length
      && before.every((entry) => fields.has(entry.field) && ["asc", "desc"].includes(entry.direction))
      && !before.some((entry) => entry.field === resource.primary_key)) {
      const after = [...structuredClone(before), { field: resource.primary_key, direction: "asc" as const }];
      return {
        category: "draft_structure",
        next_action: `Keep the existing order and append ${resource.primary_key} ascending as the unique tie-breaker for ${binding}. Resubmit Verification, then validate; no rule or permission changes.`,
        correction: {
          operation: "replace_deterministic_order",
          path: `verification.resources.${binding}.deterministic_order`,
          resource: resource.name, binding, before: structuredClone(before), after,
          catalog_digest: canonicalJsonDigest(context.builtCatalog.catalog),
          authority_granted: false, requires_validation: true,
        },
      };
    }
  }
  if (/STALE|REVISION_CHANGED|REVIEW_CHANGED/u.test(diagnostic.code)) {
    return { category: "draft_structure", next_action: "Refresh the inspected metadata and reopen the saved draft against the current reviewed revision. Preserve the business rules; do not copy an old fingerprint into a new draft." };
  }
  const collectionScope = /^verification_boundary\.resources\.([A-Za-z_][A-Za-z0-9_]*)\.collection_consistency$/u.exec(diagnostic.path ?? "");
  if (diagnostic.code === "ACTION_RULE_UNBOUNDED" && collectionScope && context) {
    const matches = context.verification?.resources.filter(entry => entry.binding === collectionScope[1]) ?? [];
    const resources = matches.length === 1
      ? context.builtCatalog.catalog.resources.filter(entry => entry.name === matches[0]!.resource)
      : [];
    if (resources.length === 1 && !resources[0]!.tenant_key) {
      return {
        category: "source_evidence",
        next_action: "Review the collection's exact child and parent scope against the current inspected foreign key and database filters. Use the existing private Action source review with metadata consent for a private collection; do not add public Read access. If the source is already in a broad intermediate Read workspace, explicitly review and narrow that workspace before private preparation. Keep the absence or aggregate condition, bounds, effect and approval policy unchanged. No draft expression can supply missing reviewed scope; keep setup pending until that evidence is available.",
      };
    }
  }
  if (/VERSION|CONFLICT|COMPLETE_COLLECTION|PHANTOM|ISOLATION/u.test(diagnostic.code)) {
    return { category: "concurrency", next_action: "Review the named verification or conflict requirement against the inspected schema. A write grant does not supply a missing conflict field, complete collection, or concurrency guarantee. Keep setup pending if the source cannot prove it." };
  }
  if (/WRITER|GRANT|RECEIPT|DEPLOYMENT/u.test(diagnostic.code)) {
    return { category: "deployment", next_action: "Open execution setup for the exact writer requirements, have the database owner review them, then refresh verification. Do not change the business rule or assume the reader can write." };
  }
  if (/FACTS_UNKNOWN|SCOPE_UNPROVEN|AMBIGUOUS|SOURCE.*MISSING|FIELD.*UNAVAILABLE/u.test(diagnostic.code)) {
    return { category: "source_evidence", next_action: "Map the named fact to an inspected authoritative source and review its meaning and scope, or save setup pending that source. Do not infer the fact from authentication, similarly named fields, or missing records." };
  }
  if (/POLICY|CURRENCY|UNIT|LIMIT.*REQUIRED/u.test(diagnostic.code)) {
    return { category: "business_decision", next_action: "Ask only for the missing business meaning, unit, or approval limit; reuse prior answers and keep all other rules unchanged." };
  }
  return { category: "draft_structure", next_action: "Correct the named draft component using the reviewed catalog, then validate again. Keep trusted scope, intended effects and approval rules unchanged; do not invent missing business evidence." };
}

import type { ActionRuleAuthoritySourceV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

/** Compare the stored contract with a no-op host compilation, not a model edit.
 * A different Read or verification structure needs its existing dependency review;
 * this narrow reconciliation can authorize annotation corrections only. */
export function actionRuleDisclosureReconciliation(previous: ActionRuleAuthoritySourceV1, current: ActionRuleAuthoritySourceV1) {
  const strip = (rule: ActionRuleAuthoritySourceV1) => ({ ...rule.verification_boundary,
    resources: rule.verification_boundary.resources.map(resource => ({ ...resource,
      fields: resource.fields.map(({ model_visible: _visibility, ...field }) => field).sort((a,b)=>a.name.localeCompare(b.name)) })).sort((a,b)=>a.binding.localeCompare(b.binding)) });
  if (previous.rule.outcome !== current.rule.outcome || previous.read_boundary_name !== current.read_boundary_name
    || previous.read_boundary_digest !== current.read_boundary_digest
    || canonicalJsonDigest(strip(previous)) !== canonicalJsonDigest(strip(current))) {
    throw new Error("ACTION_DISCLOSURE_CONTEXT_CHANGED: The exact Read dependency or verification structure changed. Reopen its dependency review; annotation reconciliation cannot authorize this change.");
  }
  const changes = previous.verification_boundary.resources.flatMap(resource => {
    // The whole non-annotation envelope is equal above, including source, scope,
    // collection semantics and field types. Never join on a column name alone.
    const next = current.verification_boundary.resources.find(item => item.binding === resource.binding && item.resource === resource.resource)!;
    return resource.fields.flatMap(field => {
      const value = next.fields.find(item => item.name === field.name)!.model_visible;
      return field.model_visible === value ? [] : [{ binding: resource.binding, resource: resource.resource,
        source: resource.source, field: field.name, before: field.model_visible ?? null, after: value ?? null }];
    });
  });
  return { changes, digest: canonicalJsonDigest({ outcome: previous.rule.outcome, read_digest: current.read_boundary_digest,
    previous: previous.verification_boundary, current: current.verification_boundary }),
    lines: changes.map(change => `${change.binding} / ${change.resource} / ${change.field}: model_visible ${change.before ?? "unknown"} -> ${change.after ?? "unknown"}`) };
}

/** Exact bounded draft differences for operator review; no inference from model
 * changed_fields or a prose success message. The replacement still compiles. */
export function actionRuleEditDifferenceLines(previous: unknown, next: unknown): string[] {
  const lines: string[] = [];
  const visit = (before: unknown, after: unknown, pointer: string) => {
    if (before === undefined && after === undefined) return;
    if (before !== undefined && after !== undefined && canonicalJsonDigest(before) === canonicalJsonDigest(after)) return;
    if (before && after && typeof before === "object" && typeof after === "object") {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        visit((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], `${pointer}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`);
      }
    } else {
      if (lines.length >= 64) throw new Error("ACTION_RULE_EDIT_REVIEW_LIMIT: This change exceeds the bounded exact edit review. Keep the current rules and prepare a smaller revision.");
      const display = (value: unknown) => value === undefined ? "absent" : JSON.stringify(value);
      lines.push(`${pointer}: ${display(before)} -> ${display(after)}`);
    }
  };
  visit(previous, next, "");
  return lines;
}

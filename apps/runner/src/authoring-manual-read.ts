import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { analyzeReadWorkloadSet, buildReadWorkloadPlanCards, normalizeReadWorkloadSet,
  readWorkloadFromPlanCards, type ReadWorkloadSet } from "./read-workload-assist.js";
import { readSubjectScopeKind } from "./read-structured-scope.js";
import { READ_SELECTION_GUIDANCE } from "./read-workload-selection-guidance.js";

type Snapshot = { candidate: ExplorationBoundaryDraft; binding: unknown };
/** A fresh direct selection is testimony about these exact proposed plans and
 * scopes. It is not structural acknowledgment or activation. The existing
 * immutable analysis and protected Read review remain the durable owners. */
export function createManualReadOwner(input: {
  load(): Promise<Snapshot>;
  session: BoundaryReviewInteractiveSession;
}) {
  let selection: { digest: string; workload: ReadWorkloadSet; roots: Map<string, string> } | undefined;
  const digest = (current: Snapshot) => canonicalJsonDigest({
    candidate: explorationBoundaryCandidateDigest(current.candidate), binding: current.binding });
  const scope = (boundary: ExplorationBoundaryDraft, root: string) => {
    const resource = boundary.pack.resources.find(item => item.id === root && !item.relationship_only);
    if (!resource) return undefined;
    const kind = readSubjectScopeKind(resource);
    if (kind === "global" && !resource.shared_reference_scope && !boundary.organization_scope)
      return undefined;
    return { kind, text: kind === "principal" ? "Only records belonging to the signed-in person."
      : kind === "tenant" ? "Organization-scoped records; not restricted to one person."
      : resource.shared_reference_scope ? "Shared-reference records with no per-person or tenant predicate."
      : "Whole-organization records with no per-person predicate." };
  };
  const accept = async (workload: ReadWorkloadSet, current: Snapshot): Promise<ReadWorkloadSet | undefined> => {
    selection = undefined;
    const exact = normalizeReadWorkloadSet(workload);
    const analysis = analyzeReadWorkloadSet({ workload: exact, generatedBoundary: current.candidate });
    const roots = new Map<string, string>();
    for (const entry of analysis.allowed) {
      if (entry.status !== "supported") throw new Error("MANUAL_READ_PLAN_UNSUPPORTED: Review the exact plan before continuing.");
      for (const atom of entry.authority_atoms) {
        const subject = scope(current.candidate, atom.root_resource);
        if (!subject) throw new Error("MANUAL_READ_SCOPE_UNRESOLVED: Review the proposed structural scope before selecting this plan.");
        roots.set(atom.root_resource, subject.kind);
      }
    }
    const before = digest(current);
    const confirmed = await input.session.confirm("Use these exact Read plans under the proposed scopes shown?", {
      defaultValue: false, context: [
        "PROPOSED READ SELECTION — structural review and activation are still required.",
        ...exact.allowed.map(entry => `${entry.id}: ${JSON.stringify(entry.plan)}`),
        ...[...roots.keys()].map(root => `${root}: ${scope(current.candidate, root)!.text}`),
        "This selects only these plans, operations and fields. It grants no Action authority.",
      ],
    });
    if (!confirmed) return undefined;
    if (digest(await input.load()) !== before) throw new Error("MANUAL_READ_SELECTION_CHANGED: The displayed candidate changed. Select the current exact plans again.");
    selection = { digest: before, workload: structuredClone(exact), roots };
    return exact;
  };
  return {
    async cards() {
      const current = await input.load();
      const cards = buildReadWorkloadPlanCards(current.candidate).map(card => ({ ...card,
        detail: `${card.detail}\nPROPOSED scope: ${scope(current.candidate, String(card.plan.resource))?.text ?? "Unresolved; structural review is required."}` }));
      if (!cards.length) throw new Error("No compiler-valid question cards are available. Review a table or use exact JSON.");
      const ids = input.session.selectReadWorkloadCards
        ? await input.session.selectReadWorkloadCards(cards, { initialSelectedIds: [],
          recommendationLabel: "Select exact plans, including any Action subject plans. No job text is interpreted and nothing is preselected." })
        : await input.session.promptText(["CHOOSE REPRESENTATIVE QUESTIONS", ...READ_SELECTION_GUIDANCE,
          ...cards.map((card, index) => `${index + 1} ${card.title}\n   ${card.detail}`),
          "Numbers (comma-separated; ranges allowed, for example 1,3-5)"].join("\n")).then(value =>
            value === undefined ? undefined : parseReadWorkloadCardSelection(value, cards.map(card => card.id)));
      return ids === undefined ? undefined : accept(readWorkloadFromPlanCards({ cards, selectedIds: ids }), current);
    },
    async exact(workload: ReadWorkloadSet) { return accept(workload, await input.load()); },
    async requirement(resources: readonly string[]): Promise<{ required: string[]; unresolved: string[] } | undefined> {
      if (!selection) return undefined;
      const roots = [...new Set(resources)].sort();
      if (digest(await input.load()) !== selection.digest) return { required: [], unresolved: roots };
      return { required: roots.filter(root => selection!.roots.get(root) === "principal"),
        unresolved: roots.filter(root => !selection!.roots.has(root)) };
    },
    async assertCurrent(workload: ReadWorkloadSet) {
      if (!selection) return;
      if (digest(await input.load()) !== selection.digest || canonicalJsonDigest(workload) !== canonicalJsonDigest(selection.workload))
        throw new Error("MANUAL_READ_SELECTION_CHANGED: The selected plans or proposed scope changed. Select them again.");
    },
  };
}

export function parseReadWorkloadCardSelection(input: string, ids: string[]): string[] {
  const normalized = input.trim().toLowerCase();
  if (normalized === "all") return [...ids];
  if (!normalized) throw new Error("Choose at least one representative question number.");
  const indexes = new Set<number>();
  for (const token of normalized.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]), end = Number(range[2]);
      if (start < 1 || end < start || end > ids.length) throw new Error(`Question range ${token} is outside 1-${ids.length}.`);
      for (let index = start; index <= end; index += 1) indexes.add(index - 1);
    } else {
      if (!/^\d+$/.test(token)) throw new Error(`Question selection ${token} is not a number or range.`);
      const index = Number(token);
      if (index < 1 || index > ids.length) throw new Error(`Question number ${index} is outside 1-${ids.length}.`);
      indexes.add(index - 1);
    }
  }
  return [...indexes].sort((left, right) => left - right).map(index => ids[index]!);
}

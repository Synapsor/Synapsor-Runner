import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { CountingDecision, PolicyTextSnapshot } from "./authoring-policy-source.js";
import { configuredCountingLimits, countingSourceRequirements } from "./authoring-counting-requirements.js";

/** Explicit business interpretation only. Never edits a selector or approves an Action. */
export async function reviewUnestablishedCounting(input: {
  source: PolicyTextSnapshot; draft: unknown; messages: readonly string[];
  session: Pick<BoundaryReviewInteractiveSession, "chooseOption" | "confirm">; assertCurrent: () => Promise<void>;
}): Promise<CountingDecision[] | undefined> {
  const unknown = countingSourceRequirements(input.source, input.draft, input.messages).filter(r => r.state !== "established");
  if (!unknown.length) return [];
  if (!input.session.chooseOption) return undefined;
  const draft = input.draft as { actions?: Array<{ outcome: string; discovery?: { title?: string } }> };
  const decisions: CountingDecision[] = [];
  for (const requirement of unknown) {
    const configured = configuredCountingLimits(input.draft).find(l => l.path === requirement.path)!;
    const context = ["COUNTING INTERPRETATION — BUSINESS REVIEW",
      `Source: ${input.source.name}; lines ${requirement.start}-${requirement.end}`,
      requirement.source_excerpt,
      `Configured Action: ${configured.outcome}`,
      `Configuration path: ${configured.path}`,
      `Configured allowance: ${configured.limit.maximum}; scope ${configured.limit.scope}; inclusive rolling ${configured.limit.window_seconds} seconds.`,
      "Which automatic approvals does this source requirement limit? Human approvals are excluded in every choice.",
      "This records your interpretation only. It does not change the saved rule, activate authority, or verify the maximum, window or other policy claims."];
    await input.assertCurrent();
    const options = [
      { value: "unresolved", label: "Keep this counting choice unresolved" },
      { value: "boundary", label: "Automatic approvals across all outcomes in this boundary" },
      ...(draft.actions ?? []).map((a, i) => ({ value: `outcome-${i}`, label: `Only automatic ${a.discovery?.title ?? a.outcome} approvals` })),
    ];
    const selected = await input.session.chooseOption("REVIEW COUNTED AUTOMATIC APPROVALS", options,
      { initialValue: "unresolved", reviewOnly: true, displayContext: true, context });
    if (!selected || selected === "unresolved" || !options.some(o => o.value === selected)) return undefined;
    const outcome = selected === "boundary" ? null : draft.actions?.[Number(selected.slice(8))]?.outcome;
    if (outcome === undefined) return undefined;
    if (!await input.session.confirm("Record this counting interpretation for these exact rules?", {
      defaultValue: false, context: [...context, `Selected meaning: ${options.find(o => o.value === selected)!.label}`],
    })) return undefined;
    await input.assertCurrent();
    decisions.push({ origin: "OPERATOR-COUNTING-REVIEW", source_digest: input.source.digest, path: requirement.path,
      configuration_digest: configured.digest, required_capability: outcome,
      operator_history_digest: canonicalJsonDigest(input.messages), reviewed_at: new Date().toISOString() });
  }
  return decisions;
}

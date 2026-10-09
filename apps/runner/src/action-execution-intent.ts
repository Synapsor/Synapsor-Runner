import { ActionRuleAuthoringError } from "./action-rule-authoring-error.js";
/** Conservative mismatch detection, never an execution grant or a draft rewrite. */
export function explicitActionExecutionIntent(messages: readonly string[]): "automatic" | "proposal_only" | undefined {
  let intent: "automatic" | "proposal_only" | undefined;
  for (const message of messages) {
    for (const sentence of message.split(/[.!?;\n]/u)) {
      if (/^\s*(?:why|how|can|could|should|would|what)\b/iu.test(sentence)) continue;
      const setupOnly = /\b(?:during (?:setup|authoring|drafting)|until .{0,40}(?:review|confirm|approval))\b/iu.test(sentence);
      // An excluded business effect ("do not write refunds") is not a global
      // execution prohibition for another explicitly requested effect.
      const globalProhibition = /\b(?:do not|don't|never) (?:(?:actually|automatically) )?(?:apply|execute|write|complete)(?:\s+(?:or|and)\s+(?:apply|execute|write|complete))*\s*(?:(?:any|the|these|those|actual|source|database)\s+)*(?:changes|data|rows|anything|requests|proposals|updates|writes|writeback|execution)?(?=\s*(?:$|,|during\b|in this\b|for (?:now|this)\b|until\b))/iu.test(sentence);
      if (!setupOnly && (globalProhibition || requestsProposalOnly(sentence)
        || /\b(?:(?:keep|leave) (?:source )?(?:writeback|execution|writes) (?:off|disabled)|(?:automatic completion|automatic execution) (?:is )?not (?:needed|wanted|requested))\b/iu.test(sentence))) {
        intent = "proposal_only";
      } else if (/\b(?:automatically|automatic)\b[^.!?;\n]{0,90}\b(?:complete|completion|execute|execution|apply)\b|\b(?:complete|execute|apply)\b[^.!?;\n]{0,60}\bautomatically\b|\bsupervised (?:source )?execution\b/iu.test(sentence)) {
        intent = "automatic";
      }
    }
  }
  return intent;
}

function requestsProposalOnly(sentence: string): boolean {
  return [...sentence.matchAll(/\bproposal[- ]only\b/giu)].some(match => {
    const before = sentence.slice(0, match.index);
    const after = sentence.slice(match.index! + match[0].length);
    // Rejecting a mode is not selecting it, nor is it an execution grant.
    const rejected = /\b(?:not|never|don't|do not|no|without|rather than|instead of)\s+(?:(?:a|just|merely|longer|use|want|keep|leave|make|switch|change|reduce|downgrade|limit|set|it|this|that|the|action|draft|mode|operation|to|as|in)\s+){0,8}$/iu.test(before)
      || /^\s+(?:(?:is|was|remains)\s+)?(?:not|no longer)\s+(?:wanted|requested|needed|desired|allowed|acceptable|sufficient)\b/iu.test(after);
    return !rejected;
  });
}

export function assertActionExecutionIntentPreserved(messages: readonly string[], writeback: "proposal_only" | "supervised"): void {
  const intent = explicitActionExecutionIntent(messages);
  if (intent === "automatic" && writeback !== "supervised") {
    throw new ActionRuleAuthoringError("ACTION_EXECUTION_INTENT_UNMET", "ACTION_EXECUTION_INTENT_UNMET: The operator requested automatic completion, not approval alone. Prepare effect.writeback=supervised as DISABLED configuration for separate operator execution review. This enables no writes. Preserve the business rule, fields and approval limits. If unsupported, explain the concrete blocker instead of claiming the proposal-only draft fulfils the job.", { presentation: "reviewed_grammar", phase: "effect" });
  }
  if (intent === "proposal_only" && writeback !== "proposal_only") {
    throw new ActionRuleAuthoringError("ACTION_EXECUTION_INTENT_UNMET", "ACTION_EXECUTION_INTENT_UNMET: The operator requested proposal-only operation. Keep effect.writeback=proposal_only; do not prepare execution authority.", { presentation: "reviewed_grammar", phase: "effect" });
  }
}

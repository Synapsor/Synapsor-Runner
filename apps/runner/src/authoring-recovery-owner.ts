import type { AuthoringInterruptedRecoveryPreview, AuthoringTransportState } from "./authoring-generation-recovery.js";
import type { PolicySourceSession } from "./authoring-policy-source.js";
import { retainedSourceRecoveryEpisode } from "./authoring-recovery-source.js";

/** Resolve the selected producer's allowance, never a similar pending target. */
export function retainedRecoveryOwner(input: {
  recovery?: AuthoringTransportState; preview: AuthoringInterruptedRecoveryPreview;
  sources?: PolicySourceSession;
  actionTurn?: {id:string;completed?:unknown;iterations_used:number;tool_calls_used:number};
}): boolean {
  const {recovery,preview}=input;
  const operation=recovery?.operations.find(op=>op.id===preview.operation_id);
  if (!operation) return false;
  if (preview.episode_id) {
    const owner=recovery?.episodes?.find(e=>e.id===preview.episode_id);
    if (!owner || operation.episode_id!==owner.id || owner.iterations_used >= (owner.conversational?12:6)
      || owner.tool_calls_used >= (owner.conversational?24:8)) return false;
    const origin=operation.producer_input;
    if (origin?.consumer==="policy_coverage") return Boolean(preview.current_context_digest===operation.context_digest && input.sources
      && retainedSourceRecoveryEpisode(input.sources,origin.context_digest,origin));
    if (origin) return origin.consumer!=="authoring_turn" || origin.episode_id===owner.id;
    // Preserve legacy generic fallback continuity only at its exact unchanged
    // context. An open untagged Source round is ambiguous: its controller cannot
    // be inferred from a same-context journal or today's stage.
    return owner.context_digest===operation.context_digest && preview.current_context_digest===operation.context_digest
      && !input.sources?.coverage_episodes?.some(e=>e.submissions.some(s=>!s.completed_at));
  }
  const origin=operation.producer_input,turn=input.actionTurn;
  return Boolean(origin?.consumer==="action_rule_components" && origin.logical_turn_id
    && turn?.id===origin.logical_turn_id && !turn.completed && turn.iterations_used<12 && turn.tool_calls_used<24);
}

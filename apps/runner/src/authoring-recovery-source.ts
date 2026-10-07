import type { ProviderHttpInput } from "./model-provider-transport.js";
import type { CoverageReviewEpisode, PolicySourceSession } from "./authoring-policy-source.js";

type SourceOrigin = Extract<NonNullable<ProviderHttpInput["authoringInput"]>, {consumer:"policy_coverage"}>;
/** A Source response round is reserved before HTTP. Its linked replacement
 * continues that exact open round; native attempts and fallback counters remain
 * separately charged. Never choose a newer same-context episode by resemblance.
 * Scoped correction proofs currently require their original live validator:
 * an unavailable proof offers local review, never a renewed full submission. */
export function retainedSourceRecoveryEpisode(sources: PolicySourceSession, key: string,
  origin: SourceOrigin): CoverageReviewEpisode | undefined {
  if (origin.context_digest !== key || origin.submission_number !== 1) return undefined;
  const matches = sources.coverage_episodes?.filter(e => e.id === origin.episode_id) ?? [];
  const episode = matches.length === 1 && matches[0]?.context === key ? matches[0] : undefined;
  return episode && episode.submissions.length === 1 && episode.submissions[0]?.number === 1
    && !episode.submissions[0].completed_at ? episode : undefined;
}

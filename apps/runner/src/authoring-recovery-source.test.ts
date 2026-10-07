import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { retainedSourceRecoveryEpisode } from "./authoring-recovery-source.js";
import type { CoverageReviewEpisode, PolicySourceSession } from "./authoring-policy-source.js";

const key=canonicalJsonDigest("exact source, draft and declared operator statements");
const original:CoverageReviewEpisode={id:"source-owner",context:key,started_at:"2026-10-06T00:00:00Z",
  submissions:[{number:1,reserved_at:"2026-10-06T00:00:01Z"}]};
const origin={consumer:"policy_coverage" as const,episode_id:original.id,context_digest:key,submission_number:1};
function sources(episodes:CoverageReviewEpisode[]):PolicySourceSession {return {id:"sources",snapshots:[],approvals:[],coverage_episodes:episodes};}

describe("exact retained Source response round",()=>{
  it("continues the original open reservation without selecting a newer same-context episode",()=>{
    const prior=structuredClone(original),newer={...structuredClone(original),id:"different-owner"};
    const state=sources([prior,newer]),before=structuredClone(state);
    expect(retainedSourceRecoveryEpisode(state,key,origin)).toBe(prior);
    expect(state).toEqual(before);
  });
  it.each(["missing owner","different context","completed round","different submission","extra round"])("does not invent a controller for %s",kind=>{
    const episode=structuredClone(original),state=sources([episode]),target={...origin};
    if(kind==="missing owner")target.episode_id="unrecorded";
    if(kind==="different context")episode.context=canonicalJsonDigest("changed business rules");
    if(kind==="completed round")episode.submissions[0]!.completed_at="2026-10-06T00:01:00Z";
    if(kind==="different submission")target.submission_number=2;
    if(kind==="extra round")episode.submissions.push({number:2,reserved_at:"2026-10-06T00:02:00Z"});
    expect(retainedSourceRecoveryEpisode(state,key,target)).toBeUndefined();
  });
  it("keeps scoped corrections pending when their live host proof is unavailable",()=>{
    const episode=structuredClone(original);episode.submissions[0]!.number=2;
    expect(retainedSourceRecoveryEpisode(sources([episode]),key,{...origin,submission_number:2})).toBeUndefined();
  });
  it("refuses duplicate owner identities instead of merging targets",()=>{
    expect(retainedSourceRecoveryEpisode(sources([structuredClone(original),structuredClone(original)]),key,origin)).toBeUndefined();
  });
});

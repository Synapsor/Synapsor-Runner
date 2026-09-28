// Qualification accounting only. Exact returned usage at a signed tariff profile.
// Prospective reservations continue using the independent conservative envelope.
import assert from 'node:assert/strict';
import {units,dollars} from './lane-c-budget-v5.mjs';

export function usageCost(observed,plan,at=new Date().toISOString()) {
  const p=plan.usage_pricing;
  assert(p&&p.provider==='openai'&&plan.provider==='openai','USAGE_PROFILE_REQUIRED');
  assert(/^[a-f0-9]{64}$/.test(p.evidence_sha256??''),'USAGE_TARIFF_EVIDENCE');
  assert(p.endpoint===plan.upstream_url,'USAGE_ENDPOINT_CHANGED');
  assert(Date.parse(at)>=Date.parse(p.valid_from)&&Date.parse(at)<=Date.parse(p.valid_until),'USAGE_TARIFF_DATE');
  assert(p.requested_model===plan.model&&p.returned_models.includes(observed.returned_model),'USAGE_MODEL_CHANGED');
  assert(observed.complete,'USAGE_INCOMPLETE');
  const tier=p.service_tiers[observed.service_tier];assert(tier,'USAGE_SERVICE_TIER');
  const u=observed.usage??{};
  const vals=[u.input_tokens,u.output_tokens,u.cached_tokens];
  const w=u.cache_write_tokens??(p.cache_writes_not_applicable===true?0:undefined);
  assert([...vals,w].every(x=>Number.isSafeInteger(x)&&x>=0),'USAGE_CATEGORIES_MISSING');
  const [i,o,c]=vals,n=i-c-w;assert(n>=0,'USAGE_CATEGORIES_OVERLAP');
  if(u.reasoning_tokens!==undefined)assert(Number.isSafeInteger(u.reasoning_tokens)&&u.reasoning_tokens>=0&&u.reasoning_tokens<=o,'USAGE_REASONING_OVERLAP');
  const rate=i>p.long_context_threshold?tier.long:tier.short;assert(rate,'USAGE_CONTEXT_TIER');
  assert(['input','cached','cache_write','output','request_fee'].every(k=>rate[k]!==undefined),'USAGE_RATE_MISSING');
  const cost=BigInt(n)*units(rate.input)+BigInt(c)*units(rate.cached)+BigInt(w)*units(rate.cache_write)+BigInt(o)*units(rate.output)+units(rate.request_fee);
  return {usd:dollars(cost),classification:'B_USAGE_COMPUTED_NOT_INVOICE',ordinary_input_tokens:n,cached_tokens:c,cache_write_tokens:w,output_tokens:o,reasoning_included:true,tariff_evidence_sha256:p.evidence_sha256,service_tier:observed.service_tier,context_tier:i>p.long_context_threshold?'long':'short'};
}

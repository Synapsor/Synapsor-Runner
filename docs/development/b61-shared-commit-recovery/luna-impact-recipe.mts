/** Reconstructed structural recipe, independently declared fictional rows and
 * newly compiled test authority. No historical identity, proof or authority is
 * imported. This is native adapter impact, not public activation evidence. */
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {createActionRuleAuthority} from '../../../packages/action-rules/src/authority.ts';
import {createSemanticActionVerifier,evaluateSemanticActionEligibility} from '../../../packages/action-rules/src/runtime.ts';
import {createPostgresActionRuleFactLoader} from '../../../packages/postgres/src/index.ts';

export const lunaFacts={tenant:'f1111111-1111-4111-8111-111111111111',principal:'f2222222-2222-4222-8222-222222222222',
 subscription:'f3333333-3333-4333-8333-333333333333',offer:'f4444444-4444-4444-8444-444444444444'};
const str={kind:'string',comparison:'exact',max_length:4096} as const;
const uuid={...str,max_length:36};
const plan={...str,max_length:14,enum:['family_premium','starter','unlimited','unlimited_plus']};
const status={...str,max_length:9,enum:['accepted','active','withdrawn']};
const integer={kind:'integer'} as const;
const money={...integer,unit:'minor_currency_units'};
const date={kind:'date'} as const;
const timestamp={kind:'timestamp'} as const;
const boolean={kind:'boolean'} as const;
const field=(binding:string,name:string)=>({kind:'field',binding,field:name});
const lit=(value:unknown,type:unknown)=>({kind:'literal',value,value_type:type});
const compare=(operator:string,left:unknown,right:unknown)=>({kind:'compare',operator,left,right});
export function freshLunaFixture(now:string,declaredFacts=lunaFacts) {
 const generation=canonicalJsonDigest({fixture:'new_luna_exact_structural_impact_v1',declaredFacts});
 const fields=(values:Record<string,unknown>)=>Object.entries(values).map(([name,type])=>({name,type,nullable:false}));
 const offerFields=fields({account_id:uuid,plan_offer_id:uuid,subscription_id:uuid,source_plan_code:plan,status,
  auto_approval_eligible:boolean,valid_from:timestamp,expires_at:timestamp,version:integer,
  target_base_monthly_cents:money,target_data_policy:str,target_effective_from:date,target_included_lines:integer,
  target_international_day_pass:boolean,target_plan_code:plan,target_plan_display_name:str});
 const subscriptionFields=fields({account_id:uuid,subscription_id:uuid,plan_code:plan,version:integer,
  base_monthly_cents:money,data_policy:str,effective_from:date,included_lines:integer,international_day_pass:boolean,plan_display_name:str});
 const offer='telecom.plan_change_offers',subscription='telecom.subscriptions';
 const relationship={name:'plan_change_offers_account_id_subscription_id_fkey',from_resource:offer,to_resource:subscription,
  field_pairs:[{local_field:'account_id',target_field:'account_id'},{local_field:'subscription_id',target_field:'subscription_id'}],cardinality:'many_to_one',target_unique:true,nullable:false};
 const catalog:any={schema_version:'synapsor.action-rule-catalog.v1',generation_lock_fingerprint:generation,resources:[
  {name:offer,source:'local_postgres',engine:'postgres',schema:'telecom',table:'plan_change_offers',primary_key:'plan_offer_id',tenant_key:'account_id',version_field:'version',fields:offerFields},
  {name:subscription,source:'local_postgres',engine:'postgres',schema:'telecom',table:'subscriptions',primary_key:'subscription_id',tenant_key:'account_id',version_field:'version',fields:subscriptionFields}],relationships:[relationship]};
 const resource=(binding:string,name:string,primary_key:string,fields:unknown[],source:unknown)=>({binding,resource:name,primary_key,version_field:'version',fields,source,scope:{mode:'columns',tenant_field:'account_id'},cardinality:'one',max_rows:1,overflow:'unsupported',lock:'for_update'});
 const verification:any={schema_version:'synapsor.verification-boundary.v1',name:'new_luna.verify',source:'local_postgres',context:'trusted_context',generation_lock_fingerprint:generation,
  resources:[resource('offer',offer,'plan_offer_id',offerFields,{kind:'subject_ref'}),resource('subscription',subscription,'subscription_id',subscriptionFields,{kind:'relationship',relationship:relationship.name,from_binding:'offer',direction:'forward',field_pairs:[{local_field:'account_id',target_field:'account_id'},{local_field:'subscription_id',target_field:'subscription_id'}]})],
  lock_order:['offer','subscription'],transaction:{isolation:'repeatable_read',timezone:'UTC'}};
 const effectTypes:Record<string,unknown>={base_monthly_cents:money,data_policy:str,effective_from:date,included_lines:integer,international_day_pass:boolean,plan_code:plan,plan_display_name:str};
 const atomicEnvelope={operation:'update',target_binding:'offer',target_resource:offer,primary_key:'plan_offer_id',tenant_key:'account_id',conflict_key:'version',max_rows:1,version_advance:{column:'version',strategy:'integer_increment'},allowed_fields:[{name:'status',type:status,values:['accepted']}]};
 const envelope:any={schema_version:'synapsor.derived-effect-envelope.v1',name:'new_luna.apply',source:'local_postgres',operation:'update',target_binding:'subscription',target_resource:subscription,primary_key:'subscription_id',tenant_key:'account_id',conflict_key:'version',max_rows:1,version_advance:{column:'version',strategy:'integer_increment'},allowed_fields:Object.entries(effectTypes).map(([name,type])=>({name,type})),atomic_updates:[atomicEnvelope],approval_classes:['new_luna.review'],writeback:{mode:'direct_sql',supervised_worker:'allowed'}};
 const rule:any={schema_version:'synapsor.action-rule.v1',name:'new_luna.accept_offer',outcome:'new_luna.accept_offer',context:'trusted_context',source:'local_postgres',verification_boundary_ref:verification.name,effect_envelope_ref:envelope.name,
  subjects:[{binding:'offer',resource:offer,input:'opaque_subject_ref'}],require:{kind:'all',expressions:[compare('eq',field('offer','status'),lit('active',status)),compare('eq',field('subscription','plan_code'),field('offer','source_plan_code'))]},derive:{},
  effect:{operation:'update',target_binding:'subscription',target_resource:subscription,set:Object.fromEntries(Object.keys(effectTypes).map(name=>[name,field('offer','target_'+name)]))},
  atomic_updates:[{operation:'update',target_binding:'offer',target_resource:offer,set:{status:lit('accepted',status)}}],approval_class:'new_luna.review',ttl_seconds:300};
 const loaded=createActionRuleAuthority({name:'new_luna.test.authority',action_boundary_name:'new_luna.actions',catalog,rules:[{read_boundary_name:'new_luna.read',read_boundary_digest:generation,verification_boundary:verification,effect_envelope:envelope,rule,activated_at:now}]});
 return {...loaded,rule,catalog,now,verifier:createSemanticActionVerifier({registry:loaded.registry,clock:()=>now}),
  decide:(client:any,proposalId:string)=>evaluateSemanticActionEligibility({registry:loaded.registry,outcome:rule.outcome,
   subjects:[{binding:'offer',resource:offer,primary_key:{column:'plan_offer_id',value:declaredFacts.offer},subject_ref_digest:canonicalJsonDigest({newProposal:proposalId,newOffer:declaredFacts.offer})}],
   trusted:{tenant:declaredFacts.tenant,principal:declaredFacts.principal,transaction_time:now},adapter:createPostgresActionRuleFactLoader(client),proposal_id:proposalId,
   trusted_context_digest:canonicalJsonDigest({tenant:declaredFacts.tenant,principal:declaredFacts.principal}),evidence_provenance_digest:canonicalJsonDigest({newFixtureProposal:proposalId}),verified_at:now})};
}

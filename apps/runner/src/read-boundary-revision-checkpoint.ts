import { Buffer } from "node:buffer";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import { assertReadCurrentStatePrerequisiteShape, type ReviewedReadCurrentStatePrerequisite } from "./read-prerequisite.js";
import type { ReviewedReadRelationship } from "./read-authoring-contract-types.js";
import type { ReadBoundaryFieldExposureChange, ModelReadBoundaryRevisionClarification,
  ModelReadBoundaryRevisionClarificationDecision } from "./read-authoring-contract-types.js";

type Digest = `sha256:${string}`;
export type ReadBoundaryRevisionCheckpoint = {
  schema_version: "synapsor.read-boundary-revision-checkpoint.v1";
  input_digest: Digest; boundary_digest: Digest; catalog_digest: Digest; tool_digest: Digest;
  stage: "waiting" | "decided";
  pending_question: {
    kind: "clarification"; request: ModelReadBoundaryRevisionClarification; question: string;
    completion?: AuthoringQuestionCompletion; decision?: ModelReadBoundaryRevisionClarificationDecision;
  };
  state: {
    call_count: number; correction_used: boolean; prerequisite_review_failed: boolean;
    issue: string; clarification_count: number;
    /** The existing producer sends its last16 answers, not a new question cap. */
    clarification_answers: Array<{ question: string; answer: string }>;
    private_decisions: ReadBoundaryFieldExposureChange[];
    reviewed_prerequisite?: ReviewedReadCurrentStatePrerequisite;
    reviewed_relationship?: ReviewedReadRelationship;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };
  digest: Digest;
};
const record=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==="object" && !Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key) && value[key]!==undefined);
const hash=(value:unknown)=>typeof value==="string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const text=(value:unknown,max:number)=>typeof value==="string" && !!value.trim() && value===value.trim() && value.length<=max;
const count=(value:unknown)=>Number.isSafeInteger(value) && (value as number)>=0;
const invalid=()=>new Error("READ_BOUNDARY_REVISION_CHECKPOINT_INVALID: The pending Read revision is malformed or changed; preserve it for inspection.");
const jsonShape=(value:unknown):boolean=>value===null || typeof value==="string" || typeof value==="boolean"
  || typeof value==="number" && Number.isFinite(value) || Array.isArray(value) && value.every(jsonShape)
  || record(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Object.values(value).every(jsonShape);

export function readBoundaryRevisionCheckpoint(input:Omit<ReadBoundaryRevisionCheckpoint,"schema_version"|"digest">):ReadBoundaryRevisionCheckpoint {
  const body={schema_version:"synapsor.read-boundary-revision-checkpoint.v1" as const,...structuredClone(input)};
  try {return parseReadBoundaryRevisionCheckpoint({...body,digest:canonicalJsonDigest(body)});}catch {throw invalid();}
}

export function readBoundaryRevisionDecisionAnswer(checkpoint:ReadBoundaryRevisionCheckpoint):string {
  const saved=parseReadBoundaryRevisionCheckpoint(checkpoint);
  if(saved.stage!=="decided")throw invalid();
  return saved.pending_question.decision!.state==="answered" ? saved.pending_question.decision!.answer : "Declined the exact Read revision clarification.";
}

/** Storage shape only. No receipt or host consent is reconstructed from JSON;
 * current catalog and retained host selections are revalidated by the producer. */
export function parseReadBoundaryRevisionCheckpoint(value:unknown):ReadBoundaryRevisionCheckpoint {
  try {if(Buffer.byteLength(JSON.stringify(value))>64*1024 || !jsonShape(value))throw invalid();}catch {throw invalid();}
  if(!record(value) || !exact(value,["schema_version","input_digest","boundary_digest","catalog_digest","tool_digest","stage","pending_question","state","digest"])
    || value.schema_version!=="synapsor.read-boundary-revision-checkpoint.v1"
    || ![value.input_digest,value.boundary_digest,value.catalog_digest,value.tool_digest,value.digest].every(hash)
    || !["waiting","decided"].includes(value.stage as string) || !record(value.pending_question) || !record(value.state))throw invalid();
  const q=value.pending_question,s=value.state;
  if(!exact(q,["kind","request","question","completion","decision"]) || q.kind!=="clarification" || !record(q.request)
    || !exact(q.request,["question","reason"]) || !text(q.request.question,500) || !text(q.request.reason,500)
    || q.question!==q.request.question || (value.stage==="waiting" ? q.decision!==undefined : !record(q.decision)))throw invalid();
  if(q.completion!==undefined) {
    const c=q.completion;
    if(!record(c) || !exact(c,["operation_id","request_digest","context_digest","response_digest"])
      || typeof c.operation_id!=="string" || !/^[a-f0-9-]{36}$/u.test(c.operation_id)
      || ![c.request_digest,c.context_digest,c.response_digest].every(hash))throw invalid();
  }
  if(q.decision!==undefined && (!record(q.decision) || !exact(q.decision,["state","answer"])
    || (q.decision.state==="answered" ? !text(q.decision.answer,1000) : q.decision.state!=="declined" || q.decision.answer!==undefined)))throw invalid();
  if(!exact(s,["call_count","correction_used","prerequisite_review_failed","issue","clarification_count","clarification_answers","private_decisions","reviewed_prerequisite","reviewed_relationship","usage"])
    || !count(s.call_count) || s.call_count===0 || typeof s.correction_used!=="boolean" || typeof s.prerequisite_review_failed!=="boolean"
    || typeof s.issue!=="string" || s.issue.length>1500 || !count(s.clarification_count)
    || (s.clarification_count as number)>(s.call_count as number)
    || !Array.isArray(s.clarification_answers) || s.clarification_answers.length!==Math.min(s.clarification_count as number,16)
    || s.clarification_answers.some(answer=>!record(answer) || !exact(answer,["question","answer"]) || !text(answer.question,500) || !text(answer.answer,1000))
    || !Array.isArray(s.private_decisions))throw invalid();
  if(q.decision && (q.decision as Record<string,unknown>).state==="answered") {
    const last=s.clarification_answers.at(-1);
    if(!record(last) || last.question!==q.question || last.answer!==(q.decision as Record<string,unknown>).answer)throw invalid();
  }
  for(const d of s.private_decisions)if(!record(d) || !exact(d,["resource","field","before","after","rationale","model_operations"])
    || !text(d.resource,256) || !text(d.field,256) || !["model_and_runner","runner_only"].includes(d.before as string) || d.after!=="runner_only"
    || d.rationale!==undefined && !text(d.rationale,500)
    || d.model_operations!==undefined && !["none","preserve_reviewed"].includes(d.model_operations as string))throw invalid();
  if(new Set(s.private_decisions.map(d=>`${d.resource}.${d.field}`)).size!==s.private_decisions.length)throw invalid();
  if(s.reviewed_prerequisite!==undefined)try {
    const p=s.reviewed_prerequisite;
    if(!record(p) || !record(p.dependency) || "rls_session" in p && !record(p.rls_session)
      || "rls_session" in p.dependency && !record(p.dependency.rls_session))throw invalid();
    assertReadCurrentStatePrerequisiteShape(p as ReviewedReadCurrentStatePrerequisite);
  }catch {throw invalid();}
  if(s.reviewed_relationship!==undefined) {
    const r=s.reviewed_relationship;
    if(!record(r) || !exact(r,["schema_version","candidate_digest","resource","relationship_id","relationship_fingerprint"])
      || r.schema_version!=="synapsor.reviewed-read-relationship.v1" || !hash(r.candidate_digest) || !hash(r.relationship_fingerprint)
      || !text(r.resource,256) || !text(r.relationship_id,256))throw invalid();
  }
  if(s.usage!==undefined && (!record(s.usage) || !exact(s.usage,["input_tokens","output_tokens","total_tokens"])
    || Object.values(s.usage).some(value=>!count(value))))throw invalid();
  const {digest,...body}=value;
  if(canonicalJsonDigest(body)!==digest)throw invalid();
  return structuredClone(value) as ReadBoundaryRevisionCheckpoint;
}

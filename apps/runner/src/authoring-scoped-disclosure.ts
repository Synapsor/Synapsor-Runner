import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PolicySourceSession, PolicyTextSnapshot } from "./authoring-policy-source.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

/** An operator-registered source condition, not automatic privacy classification. */
export type ScopedDisclosureReview = {
  origin: "OPERATOR-SOURCE-DISCLOSURE-REVIEW"; id: string; source_digest: string; source_session: string;
  start: number; end: number; source_excerpt: string;
  audience: "scoped_assistant"; purpose: "reviewed_read_discovery";
  read_digest: string; store_digest: string; metadata_digest: string;
  fields: Array<{ resource: string; field: string; binding_digest: string;
    decision: "unanswered" | "deferred" | "confirmed_non_sensitive" | "not_confirmed" }>;
  actor: string; reviewed_at: string; verified: false;
  previous: string | null; digest: string;
};
export type ScopedDisclosureInventory = {
  version: 1; reviews_digest: string;
  items: Array<{ id: string; resource: string; field: string;
    state: "unanswered" | "deferred" | "confirmed_non_sensitive" | "not_confirmed" | "stale";
    assurance: "operator_assertion_only"; verified: false }>;
};
type Context = { source_session: string; read_digest: string; store_digest: string | null; metadata_digest: string | null; reviews: ScopedDisclosureReview[] };
const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const sha = (v: unknown): v is string => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
export const scopedDisclosureReviewsDigest = (session?: PolicySourceSession) => canonicalJsonDigest(session?.scoped_disclosure_reviews ?? []);
export function disclosureFields(draft: unknown) {
  const read = object(object(draft).read);
  return (read.pack?.resources ?? []).flatMap((r: any) => (r.selectable_fields ?? []).filter((f: string) => !(r.model_withheld_fields ?? []).includes(f)).map((field: string) => ({
    resource: r.id as string, field,
    binding_digest: canonicalJsonDigest({ source: read.source ?? null, schema: r.schema ?? null, table: r.table ?? null,
      resource: r.id, field, type: r.field_types?.[field] ?? null, tenant: r.tenant_key ?? null, principal: r.principal_key ?? null,
      paths: r.relationships ?? [], relationship_only: r.relationship_only ?? false, generation: read.generation_lock_fingerprint ?? null }),
  }))).sort((a: any, b: any) => `${a.resource}.${a.field}`.localeCompare(`${b.resource}.${b.field}`)) as Array<{resource: string; field: string; binding_digest: string}>;
}
function fieldDetails(draft: unknown, selected: {resource:string;field:string}) {
  const read=object(object(draft).read), resources=read.pack?.resources??[];
  const resource=resources.find((r:any)=>r.id===selected.resource);
  const entries=resources.flatMap((r:any)=>(r.relationships??[]).filter((p:any)=>p.target_resource===selected.resource)
    .map((p:any)=>`${r.id} via ${p.id} (${p.cardinality})`));
  return `${selected.resource}.${selected.field}: ${read.source} / ${resource?.schema}.${resource?.table}; raw Read selection permitted; ${resource?.relationship_only ? 'relationship-only' : 'query root'}${entries.length?`; reviewed entries: ${entries.join('; ')}`:''}.`;
}
function identity(r: Pick<ScopedDisclosureReview, "source_digest" | "source_session" | "start" | "end" | "audience" | "purpose" | "fields">) {
  return canonicalJsonDigest({ source: r.source_digest, session:r.source_session, start: r.start, end: r.end, audience: r.audience,
    purpose: r.purpose, fields: r.fields.map(f => ({resource: f.resource, field: f.field})) });
}
export function validScopedDisclosureReview(value: ScopedDisclosureReview): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const {digest, ...body} = value;
  return value.origin === "OPERATOR-SOURCE-DISCLOSURE-REVIEW" && sha(value.source_digest)
    && typeof value.source_session === "string" && /^[a-f0-9-]{36}$/u.test(value.source_session)
    && sha(value.read_digest) && sha(value.store_digest) && sha(value.metadata_digest) && (value.previous === null || sha(value.previous))
    && Number.isInteger(value.start) && value.start >= 1 && Number.isInteger(value.end) && value.end >= value.start
    && typeof value.source_excerpt === "string" && value.source_excerpt.length > 0 && value.source_excerpt.length <= 16_000
    && value.audience === "scoped_assistant" && value.purpose === "reviewed_read_discovery" && value.verified === false
    && typeof value.actor === "string" && value.actor.length > 0 && value.actor.length <= 128
    && typeof value.reviewed_at === "string" && Number.isFinite(Date.parse(value.reviewed_at)) && Array.isArray(value.fields) && value.fields.length > 0 && value.fields.length <= 128
    && value.fields.every(f => f && typeof f.resource === "string" && f.resource.length > 0 && f.resource.length <= 256
      && typeof f.field === "string" && f.field.length > 0 && f.field.length <= 256 && sha(f.binding_digest)
      && ["unanswered", "deferred", "confirmed_non_sensitive", "not_confirmed"].includes(f.decision))
    && new Set(value.fields.map(f => `${f.resource}\0${f.field}`)).size === value.fields.length
    && value.id === identity(value) && digest === canonicalJsonDigest(body);
}
export function scopedDisclosureInventory(source: PolicyTextSnapshot, draft: unknown): ScopedDisclosureInventory {
  const context = object(object(draft).runner_evidence).scoped_disclosure as Context | undefined;
  const reviews = context?.reviews ?? [];
  assertScopedDisclosureReviews(reviews);
  const inventory: ScopedDisclosureInventory = {version: 1, reviews_digest: canonicalJsonDigest(reviews), items: []};
  if (!reviews.length) return inventory;
  const fields = disclosureFields(draft), latest = new Map<string, ScopedDisclosureReview>();
  for (const review of reviews) {
    if (!validScopedDisclosureReview(review) || review.previous !== (latest.get(review.id)?.digest ?? null))
      throw new Error("SCOPED_DISCLOSURE_EVIDENCE_INVALID: Retain this source requirement pending; its review lineage is invalid.");
    latest.set(review.id, review);
  }
  for (const review of latest.values()) {
    const current = review.source_digest === source.digest && review.source_session === context?.source_session
      && review.metadata_digest === context?.metadata_digest && review.end <= source.lines
      && review.source_excerpt === source.text.split("\n").slice(review.start - 1, review.end).join("\n")
      && context?.read_digest === review.read_digest && context.store_digest === review.store_digest;
    for (const field of review.fields) inventory.items.push({id: review.id, resource: field.resource, field: field.field,
      state: current && fields.some(f => f.resource === field.resource && f.field === field.field && f.binding_digest === field.binding_digest)
        ? field.decision : "stale", assurance: "operator_assertion_only", verified: false});
  }
  return inventory;
}

/** Explicit local registration; no text heuristic creates a requirement, and
 * no requirement is inferred from a provider's question. All choices precede save. */
export async function reviewScopedDisclosure(input: { source: PolicyTextSnapshot; draft: unknown;
  actor: string; session: BoundaryReviewInteractiveSession; assertCurrent: () => Promise<void> }): Promise<ScopedDisclosureReview | undefined> {
  const context = object(object(input.draft).runner_evidence).scoped_disclosure as Context | undefined;
  if (!context || !sha(context.read_digest) || !sha(context.store_digest) || !sha(context.metadata_digest))
    throw new Error("SCOPED_DISCLOSURE_BINDING_UNAVAILABLE: Reopen the exact selected Read and store before recording meaning.");
  await input.assertCurrent();
  const range = await input.session.promptText("Source line or line range requiring explicitly reviewed non-sensitive descriptions (Esc cancels)", {
    context: input.source.text.split("\n").map((line, i) => `${i + 1}: ${line}`) });
  if (range === undefined) return undefined;
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/u.exec(range.trim());
  const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
  if (!match || start < 1 || end < start || end > input.source.lines) throw new Error("SCOPED_DISCLOSURE_SOURCE_INVALID: Select an exact existing source range; no requirement saved.");
  const excerpt = input.source.text.split("\n").slice(start - 1, end).join("\n");
  const available = disclosureFields(input.draft);
  const selected = await input.session.promptText("Exact applicable returned field numbers, comma-separated (Esc cancels)", {
    context: [excerpt, ...available.map((f, i) => `${i + 1}: ${f.resource}.${f.field}`),
      "Choose every field to which this source condition applies. No sample values are inspected. This registers a requirement, not a grant or classification."] });
  if (selected === undefined) return undefined;
  if (!/^\d+(?:\s*,\s*\d+)*$/u.test(selected.trim())) throw new Error("SCOPED_DISCLOSURE_FIELDS_INVALID: No source requirement saved.");
  const indices = selected.split(",").map(n => Number(n.trim()) - 1);
  if (!indices.length || indices.length > 128 || new Set(indices).size !== indices.length || indices.some(n => !available[n]))
    throw new Error("SCOPED_DISCLOSURE_FIELDS_INVALID: Choose distinct current returned fields; no source requirement saved.");
  const fields = indices.map(n => ({...available[n]!, decision: "unanswered" as ScopedDisclosureReview["fields"][number]["decision"]}))
    .sort((a,b) => `${a.resource}.${a.field}`.localeCompare(`${b.resource}.${b.field}`));
  const registeredId=identity({source_digest:input.source.digest,source_session:context.source_session,start,end,
    audience:'scoped_assistant',purpose:'reviewed_read_discovery',fields});
  const existing=context.reviews.filter(r=>r.id===registeredId).at(-1);
  if(existing && scopedDisclosureInventory(input.source,input.draft).items.filter(i=>i.id===registeredId).every(i=>i.state!=='stale')) {
    input.session.rememberDetails?.('EXISTING SOURCE REQUIREMENT',[existing.source_excerpt,...disclosureStatusLines(scopedDisclosureInventory(input.source,input.draft))]);
    return existing;
  }
  const lines = ["SOURCE-REQUIRED DISCLOSURE MEANING", excerpt, ...fields.map(f => fieldDetails(input.draft,f)),
    "Recipient/purpose: the scoped assistant, for this source's reviewed Read discovery.",
    "A classification is an attributable owner assertion, not row inspection, a Read grant, publication, a promise about future contents or verified client implementation.",
    "Source prohibitions and all unrelated obligations remain independently required. A confirmation cannot waive them."];
  if (!await input.session.confirm("Register this exact source requirement and applicable fields, with classification unanswered?", {defaultValue:false,
    context:lines})) return undefined;
  await input.assertCurrent();
  const base = {origin:"OPERATOR-SOURCE-DISCLOSURE-REVIEW" as const, source_digest:input.source.digest, source_session:context.source_session, start,end,source_excerpt:excerpt,
    audience:"scoped_assistant" as const,purpose:"reviewed_read_discovery" as const,read_digest:context.read_digest,store_digest:context.store_digest,metadata_digest:context.metadata_digest,
    fields,actor:input.actor,reviewed_at:new Date().toISOString(),verified:false as const};
  const id=identity(base), previous=context.reviews.filter(r=>r.id===id).at(-1)?.digest??null;
  const body={...base,id,previous}, result={...body,digest:canonicalJsonDigest(body)};
  if (!validScopedDisclosureReview(result)) throw new Error("SCOPED_DISCLOSURE_REVIEW_INVALID: No requirement saved.");
  return result;
}

/** The ledger here is the existing PolicySourceSession; validate rather than
 * dropping malformed requirement records and accidentally making review ready. */
export function assertScopedDisclosureReviews(reviews: unknown): asserts reviews is ScopedDisclosureReview[] {
  if (reviews === undefined) return;
  if (!Array.isArray(reviews) || reviews.length > 64)
    throw new Error("SCOPED_DISCLOSURE_EVIDENCE_INVALID: Source requirements remain pending; restore the saved review records.");
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (!validScopedDisclosureReview(review) || review.previous !== (latest.get(review.id) ?? null))
      throw new Error("SCOPED_DISCLOSURE_EVIDENCE_INVALID: Source requirements remain pending; their saved lineage is invalid.");
    latest.set(review.id, review.digest);
  }
}
export function disclosureStatusLines(inventory: ScopedDisclosureInventory): string[] {
  return inventory.items.map(f => `${f.resource}.${f.field}: ${f.state === "deferred" ? "deliberately pending; classification not established" : f.state}.`);
}
/** Decisions append to an already saved requirement. Cancellation cannot erase
 * that mapping. Unknown, deferral, declined and affirmative remain distinct. */
export async function decideScopedDisclosure(input: {source: PolicyTextSnapshot; draft: unknown;
  actor: string; session: BoundaryReviewInteractiveSession; assertCurrent: () => Promise<void>}) {
  const inventory = scopedDisclosureInventory(input.source, input.draft);
  const context = object(object(input.draft).runner_evidence).scoped_disclosure as Context;
  const latest = new Map(context.reviews.map(r => [r.id,r]));
  const options = [...latest.values()].map(r => ({value:r.id, label:`Source lines ${r.start}-${r.end}: ${r.fields.map(f=>`${f.resource}.${f.field}`).join(", ")}`}));
  if (!options.length) return undefined;
  const chosen = await input.session.chooseOption?.("SOURCE-REQUIRED DISCLOSURE MEANING", [
    {value:"keep",label:"Keep saved status and return"},...options], {initialValue:"keep",reviewOnly:true,displayContext:true,
    context:[...disclosureStatusLines(inventory),"This is source-owner meaning, not permission or independent inspection. No model is called."]});
  if (!chosen || chosen === "keep") return undefined;
  const previous=latest.get(chosen);
  if (!previous || inventory.items.some(f=>f.id===chosen && f.state==='stale'))
    throw new Error("SCOPED_DISCLOSURE_CONTEXT_CHANGED: Revalidate and explicitly register the current source/Read binding. The earlier requirement stays pending.");
  await input.assertCurrent();
  const choice=await input.session.chooseOption?.("CLASSIFICATION FOR THIS EXACT SOURCE REQUIREMENT",[
    {value:"deferred",label:"Keep pending — classification not established"},
    {value:"confirmed_non_sensitive",label:"Confirm non-sensitive descriptions for this scoped use"},
    {value:"not_confirmed",label:"Not confirmed; access needs separate review"},
  ],{initialValue:"deferred",reviewOnly:true,displayContext:true,context:[previous.source_excerpt,
    ...previous.fields.map(f=>`${fieldDetails(input.draft,f)} Decision: ${f.decision}`),
    "Audience: scoped assistant. Use: reviewed Read discovery. No row values inspected.",
    "A confirmation cannot waive source prohibitions, widen access, certify future contents or verify client behavior."]});
  if(!choice || !["deferred","confirmed_non_sensitive","not_confirmed"].includes(choice))return undefined;
  let indices=previous.fields.map((_,i)=>i);
  if(choice==='confirmed_non_sensitive') {
    const value=await input.session.promptText("Field numbers you can confirm from source-owner knowledge, comma-separated (Esc cancels)",{
      context:previous.fields.map((f,i)=>`${i+1}: ${f.resource}.${f.field}`)});
    if(value===undefined)return undefined;
    if(!/^\d+(?:\s*,\s*\d+)*$/u.test(value.trim()))throw new Error("SCOPED_DISCLOSURE_FIELDS_INVALID: No decision saved.");
    indices=value.split(',').map(n=>Number(n.trim())-1);
    if(new Set(indices).size!==indices.length || indices.some(i=>!previous.fields[i]))throw new Error("SCOPED_DISCLOSURE_FIELDS_INVALID: No decision saved.");
  }
  const fields=previous.fields.map((f,i)=>({...f,decision:indices.includes(i)?choice as typeof f.decision:f.decision}));
  if(!await input.session.confirm("Save this exact classification decision?",{defaultValue:false,context:[
    previous.source_excerpt,...fields.map(f=>`${f.resource}.${f.field}: ${f.decision}`),
    "The requirement remains saved if you decline. Authority and all independent review obligations remain unchanged."]}))return undefined;
  await input.assertCurrent();
  const {digest,...body}=previous;
  const next={...body,fields,previous:digest,actor:input.actor,reviewed_at:new Date().toISOString()};
  return {...next,digest:canonicalJsonDigest(next)};
}

export function disclosureReportMatchesSession(inventory: ScopedDisclosureInventory | undefined, session: PolicySourceSession): boolean {
  const reviews=session.scoped_disclosure_reviews??[];
  assertScopedDisclosureReviews(reviews);
  if(!reviews.length)return !inventory?.items.length;
  if(!inventory || inventory.version!==1 || inventory.reviews_digest!==scopedDisclosureReviewsDigest(session) || !Array.isArray(inventory.items))return false;
  const latest=new Map(reviews.map(r=>[r.id,r]));
  const expected=[...latest.values()].flatMap(r=>r.fields.map(f=>({id:r.id,resource:f.resource,field:f.field,decision:f.decision})));
  return expected.length===inventory.items.length && expected.every(f=>{
    const matches=inventory.items.filter(i=>i.id===f.id&&i.resource===f.resource&&i.field===f.field);
    return matches.length===1 && matches[0]!.verified===false && matches[0]!.assurance==='operator_assertion_only'
      && (matches[0]!.state===f.decision || matches[0]!.state==='stale');
  });
}

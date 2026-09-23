import { createHash } from 'node:crypto';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { coverageFeedbackParentDigest, type CoverageFeedback, type CoverageFinding } from './authoring-coverage-feedback.js';
import { policyTextLines, type PolicyTextSnapshot } from './authoring-policy-source.js';
import { missingReviewSourceLines } from './authoring-source-coverage.js';
import { sourceCounterMaintenanceReferences } from './authoring-counter-maintenance-review.js';

/** Authoring transport only. Neither a scope nor an assembly certifies coverage. */
export const COVERAGE_REPAIR_CATEGORIES = ['compiled_effect', 'receipt_configuration', 'source_transaction_coupling',
  'receipt_read_exclusion', 'setup', 'receipt_observation', 'independent_readback', 'ordinary'] as const;
export type CoverageRepairCategory = typeof COVERAGE_REPAIR_CATEGORIES[number];
type RawPassage = Record<string, unknown> & { start: number; end: number };
type RawReport = { passages: RawPassage[] };
export type CoverageRepairContext = { source: PolicyTextSnapshot; draft: unknown; messages: string | readonly string[] };
export type CoverageRepairOptions = {
  /** Exact host-selected current references, never provider-supplied prefixes. */
  receiptReferences?: Partial<Record<Exclude<CoverageRepairCategory, 'ordinary'>, readonly string[]>>;
  ordinaryReferences?: readonly string[];
};
export type CoverageRepairTarget = {
  target_id: string;
  receipt_region: boolean;
  source_ranges: Array<{ start: number; end: number }>;
  members: Array<{ parent_index: number; path: string; raw_digest: string; start: number; end: number; finding_ids: string[] }>;
  /** Overlapping dependencies with no finding are read-only, still tentative. */
  required_retained: Array<{ parent_index: number; raw_digest: string }>;
  field_requirements: Array<{ start: number; end: number; resource: string; field: string; expectation: 'private' | 'business_visible' }>;
  findings: CoverageFinding[];
  allowed_references: Record<CoverageRepairCategory, string[]>;
};
export type CoverageRepairScope = {
  version: 1;
  disposition: 'unaccepted_tentative';
  context: string;
  source_digest: string;
  source_identity: string;
  /** The complete prepared draft includes selected store, subject and evidence bindings. */
  draft_digest: string;
  parent_digest: string;
  outside_digest: string;
  targets: CoverageRepairTarget[];
  scope_digest: string;
};
export type CoverageRepairMapping = {
  target_id: string; parent_indices: number[]; assembled_indices: number[];
  source_ranges: Array<{ start: number; end: number }>;
};
export class CoverageScopedCorrectionError extends Error {
  readonly code = 'COVERAGE_SCOPED_CORRECTION_REFUSED';
  constructor(reason: string) {
    super(`COVERAGE_SCOPED_CORRECTION_REFUSED: ${reason} The full review remains unaccepted. Reopen the current review or resolve the identified requirement; no whole-report rewrite was substituted.`);
  }
}
const MAX_PASSAGES = 120;
// Same argument ceiling as the existing authoring transport; assembly must not bypass it.
const MAX_ARGUMENT_BYTES = 128 * 1024;
const trustedScopes = new WeakSet<CoverageRepairScope>();
const scopeParents = new WeakMap<CoverageRepairScope, RawReport>();
function fail(reason: string): never { throw new CoverageScopedCorrectionError(reason); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value: unknown, keys: readonly string[], required: readonly string[], what: string): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail(`${what} has missing or out-of-scope fields.`);
  }
}
/** Unlike the context digest, raw digests preserve submitted object-member order. */
function rawDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function jsonValue(value: unknown, what: string): void {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { fail(`${what} must be bounded JSON data.`); }
  if (serialized === undefined) fail(`${what} is unavailable or not bounded JSON data.`);
  if (Buffer.byteLength(serialized) > MAX_ARGUMENT_BYTES) fail(`${what} exceeds the existing argument bound.`);
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 16) fail(`${what} exceeds the existing JSON nesting bound.`);
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number' && Number.isFinite(entry)) return;
    if (Array.isArray(entry)) {
      if (entry.length > 256) fail(`${what} exceeds the existing JSON array bound.`);
      for (let i = 0; i < entry.length; i++) { if (!Object.hasOwn(entry, i)) fail(`${what} contains a missing JSON item.`); visit(entry[i], depth + 1); }
      return;
    }
    if (!record(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) fail(`${what} must contain only JSON values.`);
    if (Object.keys(entry).length > 256 || Object.keys(entry).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) {
      fail(`${what} contains an invalid or excessive object key.`);
    }
    for (const child of Object.values(entry)) visit(child, depth + 1);
  };
  visit(value, 0);
}
function range(value: unknown, lines: number): value is RawPassage {
  return record(value) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
    && (value.start as number) >= 1 && (value.end as number) >= (value.start as number) && (value.end as number) <= lines;
}
function parentReport(value: unknown, source: PolicyTextSnapshot): RawReport {
  jsonValue(value, 'Immediate parent');
  exactKeys(value, ['passages'], ['passages'], 'Immediate parent envelope');
  if (!Array.isArray(value.passages) || !value.passages.length || value.passages.length > MAX_PASSAGES
    || !value.passages.every(p => range(p, policyTextLines(source.text).length))) fail('The immediate parent has no uniquely usable passage ranges.');
  if (missingReviewSourceLines(source, value.passages)?.length) fail('The immediate parent omits source lines, so no existing local region can repair its global accounting.');
  return value as RawReport;
}
const contextDigest = (context: CoverageRepairContext) => canonicalJsonDigest({ source: context.source.digest, draft: context.draft, messages: context.messages });
const overlap = (a: {start: number; end: number}, b: {start: number; end: number}) => a.start <= b.end && b.start <= a.end;
const root = '/runner_evidence/runtime_contract';
const receiptPaths = new Set([`${root}/receipt_configuration`, `${root}/receipt_read_exclusion`, `${root}/receipts`,
  `${root}/application_obligations/independent_source_readback`]);
const receiptCodes = new Set(['RECEIPT_READ_EXCLUSION_UNESTABLISHED', 'COVERAGE_RECEIPT_REFERENCE_OVERBROAD',
  'OBLIGATION_CONFIGURATION_COMPONENT_MIXED', 'OBLIGATION_OBSERVATION_UNESTABLISHED',
  'OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED']);
function pointerExists(draft: unknown, pointer: string): boolean {
  if (!pointer.startsWith('/') || pointer.length > 500 || /~(?:[^01]|$)/u.test(pointer)) return false;
  let value = draft;
  for (const key of pointer.slice(1).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return true;
}
function references(passages: RawPassage[], findings: CoverageFinding[], context: CoverageRepairContext, options: CoverageRepairOptions, receipt: boolean) {
  const submitted = passages.flatMap(p => Array.isArray(p.draft_paths) ? p.draft_paths.filter((v): v is string => typeof v === 'string') : []);
  const nominated = [...submitted, ...passages.flatMap(p => [
    ...(['counter_requirements', 'evidence_checks'] as const).flatMap(key => Array.isArray(p[key])
      ? p[key].flatMap(child => record(child) && typeof child.path === 'string' ? [child.path] : []) : []),
    ...(record(p.source_counter_obligation) && typeof p.source_counter_obligation.path === 'string' ? [p.source_counter_obligation.path] : []),
  ]), ...findings.flatMap(f => f.current_evidence ? [f.current_evidence.path] : [])];
  // A cited child of an exact inspected constraint can repair its enclosing
  // constraint locator. Never nominate the whole resource or constraint list.
  const constraintParents = nominated.flatMap(path =>
    /^\/runner_evidence\/source_constraints\/resources\/[^/]+\/(?:unique_constraints|check_constraints)\/[^/]+/u.exec(path)?.[0] ?? []);
  const counterChildren = sourceCounterMaintenanceReferences(context.draft).filter(path =>
    submitted.some(parent => /^\/runner_evidence\/actions\/[^/]+\/effect$/u.test(parent) && path.startsWith(`${parent}/`)));
  const effectOperationChildren = submitted.filter(parent => /^\/runner_evidence\/actions\/[^/]+\/effect$/u.test(parent))
    .map(parent => `${parent}/operation`);
  // Typed source associations can repair an incorrect locator without opening
  // the whole evidence catalog. Names come from this nominated parent group,
  // and each resulting exact path must already exist in the current context.
  const associated: string[] = [];
  const evidence = record(context.draft) && record(context.draft.runner_evidence) ? context.draft.runner_evidence : {};
  const escape = (key: string) => key.replace(/~/gu,'~0').replace(/\//gu,'~1');
  for (const passage of passages) {
    const prerequisites = ['authenticated_identity','runner_client_connection','runner_execution_setup'];
    if (typeof passage.deployment_prerequisite === 'string' && prerequisites.includes(passage.deployment_prerequisite)) {
      associated.push(`${root}/deployment_prerequisites/${passage.deployment_prerequisite}`);
    }
    if (Array.isArray(passage.draft_paths) && passage.draft_paths.includes(`${root}/deployment_prerequisites`)) {
      associated.push(...prerequisites.map(name=>`${root}/deployment_prerequisites/${name}`));
    }
    if (Array.isArray(passage.application_obligations)) for (const name of passage.application_obligations) {
      if (typeof name === 'string' && ['customer_selection','status_presentation','independent_source_readback'].includes(name)) associated.push(`${root}/application_obligations/${name}`);
    }
    if (!Array.isArray(passage.field_checks)) continue;
    for (const check of passage.field_checks) {
      if (!record(check) || typeof check.resource !== 'string' || typeof check.field !== 'string') continue;
      const resource=escape(check.resource), field=escape(check.field);
      associated.push(`/runner_evidence/read_access/${resource}/fields/${field}`,
        `/runner_evidence/excluded_field_access/resources/${resource}/fields/${field}`);
      for (const [outcome,action] of Object.entries(record(evidence.actions)?evidence.actions:{})) {
        if (!record(action) || !record(action.scoped_bindings)) continue;
        for (const [name,binding] of Object.entries(action.scoped_bindings)) if (record(binding) && binding.resource === check.resource) {
          associated.push(`/runner_evidence/actions/${escape(outcome)}/scoped_bindings/${escape(name)}/fields/${field}`);
        }
      }
    }
  }
  // An effect in another outcome is never nominated merely because it is current.
  const actionRoots = [...new Set(submitted.flatMap(path => /^\/runner_evidence\/actions\/[^/]+(?:\/|$)/u.exec(path)?.[0].replace(/\/$/u, '') ?? []))];
  // A mixed writer/reader setup claim can omit its deployment label. Only the
  // host's exact mixed-deployment finding plus a cited current direct-SQL
  // execution binding may nominate the matching pending setup contract.
  if (!receipt && findings.some(f => f.code === 'COVERAGE_DEPLOYMENT_COMPONENT_MIXED')
    && passages.some(p => p.responsibility === 'deployment' && p.issue_kind === 'missing_configuration'
      && p.disposition === 'needs_decision' && Array.isArray(p.draft_paths)
      && p.draft_paths.includes('/read') && actionRoots.some(actionRoot =>
        (p.draft_paths as string[]).includes(`${actionRoot}/execution`)
        && pointerExists(context.draft, `${actionRoot}/execution`)
        && (context.draft as any)?.runner_evidence?.actions?.[actionRoot.slice('/runner_evidence/actions/'.length).replace(/~1/gu, '/').replace(/~0/gu, '~')]?.execution?.configured_mode === 'direct_sql'))
    && (context.draft as any)?.runner_evidence?.runtime_contract?.deployment_prerequisites?.runner_execution_setup?.supported === true
    && (context.draft as any)?.runner_evidence?.runtime_contract?.deployment_prerequisites?.runner_execution_setup?.stage === 'after_authority_review') {
    associated.push(`${root}/deployment_prerequisites/runner_execution_setup`);
  }
  const current = (paths: readonly string[]) => [...new Set(paths)].filter(path => pointerExists(context.draft, path)).sort();
  const defaults: Record<CoverageRepairCategory, string[]> = {
    compiled_effect: actionRoots.flatMap(path => [`${path}/effect`, `${path}/execution`]),
    receipt_configuration: [`${root}/receipt_configuration`, `${root}/receipts`],
    source_transaction_coupling: [...actionRoots.flatMap(path => [`${path}/effect`, `${path}/execution`]), `${root}/receipts`],
    receipt_read_exclusion: [`${root}/receipt_read_exclusion`],
    setup: [`${root}/receipt_configuration`, `${root}/deployment_prerequisites/runner_execution_setup`],
    // The standard authoring context supplies no operation-bound observations.
    receipt_observation: [],
    independent_readback: [`${root}/application_obligations/independent_source_readback`],
    // The supplied general catalog cannot introduce an association; only the
    // exact parent references and the typed matches above nominate a reference.
    ordinary: receipt ? [] : current([...nominated,...constraintParents,...counterChildren,...effectOperationChildren,...associated]),
  };
  for (const category of COVERAGE_REPAIR_CATEGORIES) {
    if (category === 'ordinary') continue;
    if (!receipt) { defaults[category] = []; continue; }
    const selected = options.receiptReferences?.[category] ?? defaults[category];
    if (options.receiptReferences?.[category]?.some(path => !pointerExists(context.draft, path))) fail('A host-nominated receipt reference is absent from this exact prepared context.');
    if (options.receiptReferences?.[category]?.some(path => !defaults[category].some(base => path === base || path.startsWith(`${base}/`)))) {
      fail('A receipt reference would expand beyond the nominated source group and evidence families.');
    }
    defaults[category] = current(selected);
  }
  return defaults;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** The caller supplies feedback from collectCoverageFeedback, never model data.
 * Component coordinates locate records only inside this exact hashed parent. */
export function createCoverageRepairScope(parent: unknown, feedback: CoverageFeedback, context: CoverageRepairContext,
  options: CoverageRepairOptions = {}): CoverageRepairScope {
  const raw = parentReport(parent, context.source), identity = contextDigest(context);
  if (coverageFeedbackParentDigest(feedback) !== rawDigest(raw)) fail('The findings are not the host traversal of this exact immediate parent.');
  if (feedback.context !== identity || feedback.complete_validation !== false || feedback.limited || !feedback.findings.length
    || !feedback.findings.every(f => f.structural)) fail('Every finding must be a current, bounded structural finding.');
  const located = feedback.findings.map(finding => {
    const match = /^\/passages\/(0|[1-9]\d*)(?:\/(counter_requirements|draft_paths|evidence_checks)\/(0|[1-9]\d*))?$/u.exec(finding.component);
    const index = match ? Number(match[1]) : -1, passage = raw.passages[index];
    if (!match || !passage) fail('A finding has no unique passage or supported child in the immediate parent.');
    if (match[2] && (!Array.isArray(passage[match[2]]) || Number(match[3]) >= (passage[match[2]] as unknown[]).length)) {
      fail('A finding child does not exist in the immediate parent.');
    }
    const basis = { start: passage.start, end: passage.end, component: finding.component.replace(/^\/passages\/\d+/u, 'passage') };
    if (finding.passage_identity !== canonicalJsonDigest({start: passage.start, end: passage.end})
      || finding.component_identity !== canonicalJsonDigest(basis)) fail('A finding identity does not match its exact immediate-parent passage.');
    return { finding, index };
  });
  if (new Set(located.map(({finding}) => `${finding.component}:${finding.identity}`)).size !== located.length) fail('Duplicated or ambiguous finding identities cannot nominate a region.');
  const parentDigest = rawDigest(raw), targets: CoverageRepairTarget[] = [], covered = new Set<number>();
  for (const location of located) {
    if (covered.has(location.index)) continue;
    const closure = new Set([location.index]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [index, passage] of raw.passages.entries()) if (!closure.has(index)
        && [...closure].some(member => overlap(raw.passages[member]!, passage))) { closure.add(index); grew = true; }
    }
    const indices = [...closure].sort((a, b) => a - b), passages = indices.map(index => raw.passages[index]!);
    // A broad source citation must not expand one repair into a rewrite of
    // every otherwise unrelated source range. One exact shared range remains
    // a local group even in a tiny single-group report.
    if (closure.size === raw.passages.length && new Set(passages.map(p => `${p.start}:${p.end}`)).size > 1) {
      fail('Overlap closure spans the whole report across distinct source ranges, so a safely local repair cannot be nominated.');
    }
    for (const index of indices) covered.add(index);
    const findings = located.filter(item => closure.has(item.index)).map(item => structuredClone(item.finding));
    const members = indices.map(index => ({ parent_index: index, path: `/passages/${index}`, raw_digest: rawDigest(raw.passages[index]),
      start: raw.passages[index]!.start, end: raw.passages[index]!.end,
      finding_ids: located.filter(item => item.index === index).map(item => item.finding.identity).sort() }));
    // An unchallenged approval/counting companion may cite the receipt
    // overview. Closure retains that record, but it does not turn a counter
    // citation repair into a receipt-category rewrite.
    const challenged = located.filter(item => closure.has(item.index) && item.finding.code === 'COVERAGE_REFERENCE_MISSING')
      .map(item => raw.passages[item.index]!);
    const receipt = findings.some(f => receiptCodes.has(f.code)) || challenged.some(p => Array.isArray(p.draft_paths)
      && p.draft_paths.some(path => typeof path === 'string' && [...receiptPaths].some(base => path === base || path.startsWith(`${base}/`))));
    const sourceRanges = [{ start: Math.min(...passages.map(p => p.start)), end: Math.max(...passages.map(p => p.end)) }];
    const allowedReferences = references(passages, findings, context, options, receipt);
    if (!receipt && !allowedReferences.ordinary.length && passages.some(p => !['background', 'overridden'].includes(p.disposition as string))) {
      fail('No exact current reference can safely repair this ordinary source group; the finding needs a separately established evidence association.');
    }
    targets.push({ target_id: canonicalJsonDigest({parent: parentDigest, context: identity, members}), receipt_region: receipt,
      source_ranges: sourceRanges, members,
      required_retained: members.filter(member => !member.finding_ids.length).map(({parent_index,raw_digest})=>({parent_index,raw_digest})),
      field_requirements: passages.flatMap(p=>Array.isArray(p.field_checks)?p.field_checks.flatMap(check=>
        record(check)&&typeof check.resource==='string'&&typeof check.field==='string'&&(check.expectation==='private'||check.expectation==='business_visible')
          ?[{start:p.start,end:p.end,resource:check.resource,field:check.field,expectation:check.expectation}]:[]):[]),
      findings, allowed_references: allowedReferences });
  }
  targets.sort((a,b) => a.members[0]!.parent_index - b.members[0]!.parent_index);
  const base = { version: 1 as const, disposition: 'unaccepted_tentative' as const, context: identity,
    source_digest: context.source.digest, source_identity: canonicalJsonDigest(context.source), draft_digest: canonicalJsonDigest(context.draft),
    parent_digest: parentDigest, outside_digest: rawDigest(raw.passages.filter((_, index) => !covered.has(index))), targets };
  const scope = freeze({ ...base, scope_digest: canonicalJsonDigest(base) });
  trustedScopes.add(scope);
  scopeParents.set(scope,structuredClone(raw));
  return scope;
}
function checkScope(scope: CoverageRepairScope): void {
  if (!trustedScopes.has(scope)) fail('Only the original host-created repair scope may be used.');
  const { scope_digest, ...base } = scope;
  if (canonicalJsonDigest(base) !== scope_digest) fail('The host repair scope changed.');
}
const passageKeys = ['start', 'end', 'disposition', 'interpretation', 'draft_paths', 'operator_override', 'operator_message_id',
  'operator_clarification', 'topic', 'responsibility', 'issue_kind', 'next_step', 'evidence_checks', 'counter_requirements',
  'field_checks', 'application_obligations', 'deployment_prerequisite', 'source_counter_obligation', 'receipt_component'];
function replacementPassage(value: unknown, category: CoverageRepairCategory, target: CoverageRepairTarget, source: PolicyTextSnapshot): RawPassage {
  exactKeys(value, passageKeys, ['start', 'end', 'disposition', 'interpretation', 'draft_paths'], 'Replacement passage');
  if (!range(value, policyTextLines(source.text).length) || !target.source_ranges.some(span => value.start >= span.start && value.end <= span.end)) {
    fail('A replacement addresses source lines outside its nominated region.');
  }
  if (!Array.isArray(value.draft_paths) || value.draft_paths.length > 32 || value.draft_paths.some(path => typeof path !== 'string'
    || !target.allowed_references[category].includes(path))) fail('A replacement reference is outside its nominated category and exact permitted references.');
  if (value.receipt_component !== undefined && (category !== 'source_transaction_coupling' || value.receipt_component !== category)) {
    fail('The typed receipt component disagrees with its nominated category.');
  }
  const children: Array<[string, string[], string[]]> = [
    ['counter_requirements', ['path', 'current_capability', 'required_capability', 'operator_message_id', 'operator_clarification'], ['path', 'current_capability', 'required_capability']],
    ['evidence_checks', ['path', 'equals'], ['path', 'equals']],
    ['field_checks', ['resource', 'field', 'expectation'], ['resource', 'field', 'expectation']],
  ];
  for (const [key, keys, required] of children) if (value[key] !== undefined) {
    if (!Array.isArray(value[key])) fail('A replacement nested component must be an array.');
    for (const child of value[key] as unknown[]) {
      exactKeys(child, keys, required, 'Replacement nested component');
      if (key === 'field_checks' && !target.field_requirements.some(check=>check.resource===child.resource&&check.field===child.field&&check.expectation===child.expectation)) {
        fail('A replacement field check is outside the exact nominated resource, field and expectation.');
      }
      if (key !== 'field_checks' && (typeof child.path !== 'string' || !target.allowed_references[category].includes(child.path))) {
        fail('A replacement child reference is outside its exact permitted references.');
      }
    }
  }
  if (value.source_counter_obligation !== undefined) {
    exactKeys(value.source_counter_obligation, ['path', 'requirement'], ['path', 'requirement'], 'Replacement source counter');
    if (!target.allowed_references[category].includes(value.source_counter_obligation.path as string)) fail('The source counter reference is outside its nominated region.');
  }
  return value;
}
/** Deterministic raw projection: unwrap category/passages, splice each entire
 * nominated overlap closure once at its first parent position, retain every
 * outside record in order. No prose, evidence or accepted meaning is added. */
export function assembleScopedCoverageReplacement(scope: CoverageRepairScope, parent: unknown, payload: unknown, context: CoverageRepairContext) {
  checkScope(scope);
  const raw = parentReport(parent, context.source);
  if (scope.context !== contextDigest(context) || scope.source_digest !== context.source.digest
    || scope.source_identity !== canonicalJsonDigest(context.source) || scope.draft_digest !== canonicalJsonDigest(context.draft)) {
    fail('Source, store, subject or prepared context changed since nomination.');
  }
  if (rawDigest(raw) !== scope.parent_digest) fail('The replacement does not use the exact immediate parent.');
  jsonValue(payload, 'Scoped replacement');
  exactKeys(payload, ['scope_digest', 'parent_digest', 'context', 'groups'], ['scope_digest', 'parent_digest', 'context', 'groups'], 'Scoped replacement envelope');
  if (payload.scope_digest !== scope.scope_digest || payload.parent_digest !== scope.parent_digest || payload.context !== scope.context) {
    fail('The replacement names a different scope, parent or context.');
  }
  if (!Array.isArray(payload.groups) || payload.groups.length !== scope.targets.length) fail('Every nominated group must be supplied exactly once.');
  const replacements = new Map<string, Array<{ category: CoverageRepairCategory; passage: RawPassage }>>();
  for (const group of payload.groups) {
    exactKeys(group, ['target_id', 'replacements'], ['target_id', 'replacements'], 'Replacement group');
    const target = scope.targets.find(target => target.target_id === group.target_id);
    if (!target || replacements.has(target.target_id)) fail('A replacement group is unrequested or duplicated.');
    if (!Array.isArray(group.replacements) || !group.replacements.length || group.replacements.length > MAX_PASSAGES) fail('A replacement group cannot be empty or exceed the passage ceiling.');
    const entries = group.replacements.map(entry => {
      exactKeys(entry, ['category', 'passage'], ['category', 'passage'], 'Replacement component');
      const category = entry.category as CoverageRepairCategory;
      if (!COVERAGE_REPAIR_CATEGORIES.includes(category) || (category === 'ordinary') === target.receipt_region) {
        fail('Receipt regions require explicit receipt/effect categories; ordinary is available only for non-receipt regions.');
      }
      return { category, passage: replacementPassage(entry.passage, category, target, context.source) };
    });
    if (new Set(entries.map(entry => rawDigest(entry.passage))).size !== entries.length) fail('A replacement group repeats the same raw component.');
    for (const retained of target.required_retained) if (entries.filter(entry => rawDigest(entry.passage) === retained.raw_digest).length !== 1) {
      fail('Every unchallenged overlap dependency must be retained exactly once with its complete original raw fields; omission or a weaker duty is not a repair.');
    }
    for (const required of target.field_requirements) for (let line=required.start;line<=required.end;line++) {
      if(!entries.some(({passage})=>passage.start<=line&&passage.end>=line&&Array.isArray(passage.field_checks)
        &&passage.field_checks.some(check=>record(check)&&check.resource===required.resource&&check.field===required.field&&check.expectation===required.expectation))) {
        fail('A replacement removes a nominated field requirement or its original source association.');
      }
    }
    const overrideDecision=(passage:RawPassage)=>Object.fromEntries(['operator_override','operator_message_id','operator_clarification']
      .filter(key=>Object.hasOwn(passage,key)).map(key=>[key,passage[key]]));
    for (const entry of entries) if (['background', 'overridden'].includes(entry.passage.disposition as string)
      && !target.members.some(member => {
        const prior=raw.passages[member.parent_index]!;
        return rawDigest(prior) === rawDigest(entry.passage)
          || entry.passage.disposition==='overridden'&&prior.disposition==='overridden'
            &&prior.start===entry.passage.start&&prior.end===entry.passage.end
            &&Object.keys(overrideDecision(prior)).length>0
            &&rawDigest(overrideDecision(prior))===rawDigest(overrideDecision(entry.passage));
      })) {
      fail('A replacement cannot create a background or overridden reclassification; only exact existing records may retain those dispositions.');
    }
    for (const member of target.members) for (let line = member.start; line <= member.end; line++) {
      const covering = entries.filter(entry => entry.passage.start <= line && line <= entry.passage.end);
      if (!covering.length) fail('A replacement deletes part of its nominated source requirement.');
      if (!['background', 'overridden'].includes(raw.passages[member.parent_index]!.disposition as string)
        && !covering.some(entry => !['background', 'overridden'].includes(entry.passage.disposition as string))) {
        fail('A substantive parent requirement cannot become only background or overridden.');
      }
    }
    replacements.set(target.target_id, entries);
  }
  const passages: RawPassage[] = [], mapping: CoverageRepairMapping[] = [];
  const categories: Array<{ index: number; category: CoverageRepairCategory; target_id: string }> = [];
  const retained: Array<{ parent_index: number; assembled_index: number; raw_digest: string }> = [];
  for (const [index, passage] of raw.passages.entries()) {
    const target = scope.targets.find(target => target.members.some(member => member.parent_index === index));
    if (!target) { retained.push({parent_index: index, assembled_index: passages.length, raw_digest: rawDigest(passage)}); passages.push(structuredClone(passage)); continue; }
    if (index !== target.members[0]!.parent_index) continue;
    const assembledIndices: number[] = [];
    for (const entry of replacements.get(target.target_id)!) {
      assembledIndices.push(passages.length); categories.push({ index: passages.length, category: entry.category, target_id: target.target_id });
      passages.push(structuredClone(entry.passage));
    }
    mapping.push({ target_id: target.target_id, parent_indices: target.members.map(member => member.parent_index),
      assembled_indices: assembledIndices, source_ranges: structuredClone(target.source_ranges) });
  }
  if (passages.length > MAX_PASSAGES) fail('The complete assembled report exceeds the existing 120-passage ceiling.');
  const assembled = { passages };
  jsonValue(assembled, 'Complete assembled report');
  if (missingReviewSourceLines(context.source, passages)?.length) fail('The complete assembled report omits source lines.');
  const outsideDigest = rawDigest(retained.map(item => passages[item.assembled_index]));
  if (outsideDigest !== scope.outside_digest) fail('An outside raw record changed during assembly.');
  return { assembled, categories, mapping, retained,
    audit: { disposition: 'unaccepted_tentative' as const, raw_parent: structuredClone(raw), raw_replacement: structuredClone(payload),
      scope: structuredClone(scope), assembled: structuredClone(assembled), parent_digest: scope.parent_digest,
      replacement_digest: rawDigest(payload), assembled_digest: rawDigest(assembled), outside_digest: outsideDigest } };
}

/** The schema confines generation; assembly and the complete existing parser
 * independently enforce the boundary. A category enum is never evidence. */
export function scopeToolSchema(scope: CoverageRepairScope, passageSchema: Record<string, unknown>): Record<string, unknown> {
  checkScope(scope);
  const retainedCategory=(target:CoverageRepairTarget,p:RawPassage):CoverageRepairCategory=>{
    if(!target.receipt_region)return 'ordinary';
    if(p.receipt_component==='source_transaction_coupling')return 'source_transaction_coupling';
    if(p.responsibility==='deployment'||p.deployment_prerequisite!==undefined)return 'setup';
    if(Array.isArray(p.application_obligations)&&p.application_obligations.includes('independent_source_readback'))return 'independent_readback';
    const paths=Array.isArray(p.draft_paths)?p.draft_paths:[];
    if(paths.includes(`${root}/receipt_read_exclusion`))return 'receipt_read_exclusion';
    if(paths.includes(`${root}/receipt_configuration`))return 'receipt_configuration';
    if(paths.includes(`${root}/receipts`))return 'receipt_observation';
    return 'compiled_effect';
  };
  return { type: 'object', additionalProperties: false, required: ['scope_digest', 'parent_digest', 'context', 'groups'], properties: {
    scope_digest: {type: 'string', const: scope.scope_digest}, parent_digest: {type: 'string', const: scope.parent_digest},
    context: {type: 'string', const: scope.context}, groups: { type: 'array', minItems: scope.targets.length, maxItems: scope.targets.length,
      items: { oneOf: scope.targets.map(target => ({ type: 'object', additionalProperties: false, required: ['target_id', 'replacements'], properties: {
        target_id: {type: 'string', const: target.target_id}, replacements: { type: 'array', minItems: 1, maxItems: MAX_PASSAGES,
          description: `Retain each read-only dependency from immediate-parent passage indices ${JSON.stringify(target.required_retained.map(member=>member.parent_index))} exactly once, with all raw fields unchanged. Only members with findings may be edited. Every retained dependency remains tentative and is revalidated.`,
          items: { oneOf: COVERAGE_REPAIR_CATEGORIES.filter(category => category === 'ordinary' ? !target.receipt_region : target.receipt_region)
            .map(category => {
              const properties = structuredClone(record(passageSchema.properties) ? passageSchema.properties : {});
              properties.start = {type: 'integer', minimum: target.source_ranges[0]!.start, maximum: target.source_ranges[0]!.end};
              properties.end = structuredClone(properties.start);
              properties.draft_paths = target.allowed_references[category].length
                ? {type: 'array', maxItems: 32, items: {type: 'string', enum: target.allowed_references[category]}}
                : {type: 'array', maxItems: 0, items: {type: 'string'}};
              for (const key of ['counter_requirements', 'evidence_checks', 'source_counter_obligation']) {
                const property = properties[key];
                const child = key === 'source_counter_obligation' ? property : record(property) ? property.items : undefined;
                if (!record(child) || !record(child.properties) || !record(child.properties.path)) continue;
                const existing = child.properties.path.enum;
                const permitted = target.allowed_references[category].filter(path => !Array.isArray(existing) || existing.includes(path));
                if (!permitted.length) delete properties[key];
                else child.properties.path = { ...child.properties.path, type: 'string', enum: permitted };
              }
              if(record(properties.field_checks)) {
                const checks=target.field_requirements.map(({resource,field,expectation})=>({resource,field,expectation}));
                if(!checks.length)delete properties.field_checks;
                else properties.field_checks={...properties.field_checks,items:{enum:checks}};
              }
              if (category === 'source_transaction_coupling') properties.receipt_component = {type: 'string', const: category};
              else delete properties.receipt_component;
              return { type: 'object', additionalProperties: false, required: ['category', 'passage'], properties: {
                category: {type: 'string', const: category}, passage: { ...structuredClone(passageSchema), properties,
                  ...(target.required_retained.length ? {not:{enum:target.required_retained.map(member=>structuredClone(scopeParents.get(scope)!.passages[member.parent_index]!))}} : {}),
                  ...(category === 'source_transaction_coupling' ? {required: [...new Set([...(Array.isArray(passageSchema.required) ? passageSchema.required : []), 'receipt_component'])]} : {}) },
              } };
            }).concat(target.required_retained.map(member=>{
              const passage=structuredClone(scopeParents.get(scope)!.passages[member.parent_index]!);
              return {type:'object',additionalProperties:false,required:['category','passage'],properties:{
                category:{type:'string',const:retainedCategory(target,passage)},passage:{const:passage},
              }};
            }) as any) },
        },
      } })) },
    },
  } };
}

/** The finite provider declaration for the existing scoped operation. The
 * exact target/category/retained-record correlations in scopeToolSchema use
 * composition and literal-object constraints that are not portable across the
 * selected function-tool route. This closed typed superset preserves the
 * expressible bounds; assembleScopedCoverageReplacement and the complete
 * review parser still enforce every correlation before persistence. */
export function portableScopeToolSchema(scope: CoverageRepairScope, passageSchema: Record<string, unknown>,
  constrainedSchema: Record<string, unknown>): Record<string, unknown> {
  checkScope(scope);
  if (!scope.targets.length || !record(passageSchema.properties) || !Array.isArray(passageSchema.required)
    || passageSchema.type !== 'object' || passageSchema.additionalProperties !== false) {
    fail('A bounded, closed passage declaration is unavailable for the scoped provider request.');
  }
  const parent = scopeParents.get(scope);
  if (!parent) fail('The exact immediate parent is unavailable for the scoped provider request.');
  const groups = record(constrainedSchema.properties) && record(constrainedSchema.properties.groups)
    && record(constrainedSchema.properties.groups.items) ? constrainedSchema.properties.groups.items.oneOf : undefined;
  if (!Array.isArray(groups) || groups.length !== scope.targets.length) fail('The exact constrained correction variants are unavailable.');
  const categoryMeanings: Record<string,string[]> = {};
  for (const [index, variant] of groups.entries()) {
    if (!record(variant) || !record(variant.properties) || !record(variant.properties.target_id)
      || variant.properties.target_id.const !== scope.targets[index]!.target_id
      || !record(variant.properties.replacements) || !record(variant.properties.replacements.items)
      || !Array.isArray(variant.properties.replacements.items.oneOf)) {
      fail('The constrained correction variants no longer match the nominated targets.');
    }
    for (const alternative of variant.properties.replacements.items.oneOf) {
      if (!record(alternative) || !record(alternative.properties) || !record(alternative.properties.category)
        || !record(alternative.properties.passage) || Object.hasOwn(alternative.properties.passage,'const')) continue;
      const category = alternative.properties.category.const;
      const meaning = record(alternative.properties.passage.properties)
        && record(alternative.properties.passage.properties.interpretation)
        ? alternative.properties.passage.properties.interpretation.enum : undefined;
      if (typeof category === 'string' && Array.isArray(meaning) && meaning.every(item=>typeof item==='string')) {
        categoryMeanings[category] = [...new Set([...(categoryMeanings[category]??[]),...meaning])];
      }
    }
  }
  const categories = new Set<CoverageRepairCategory>();
  const references = new Set<string>();
  let firstLine = Infinity, lastLine = 0;
  for (const target of scope.targets) {
    if (!target.source_ranges.length) fail('A target has no bounded source range.');
    for (const range of target.source_ranges) {
      firstLine = Math.min(firstLine, range.start);
      lastLine = Math.max(lastLine, range.end);
    }
    for (const category of COVERAGE_REPAIR_CATEGORIES) {
      if ((category === 'ordinary') === target.receipt_region) continue;
      categories.add(category);
      for (const path of target.allowed_references[category]) references.add(path);
    }
    // Read-only overlap dependencies must remain representable even if their
    // exact references are not editable in this category.
    for (const retained of target.required_retained) {
      const passage = parent.passages[retained.parent_index];
      if (!passage || rawDigest(passage) !== retained.raw_digest) fail('A retained parent dependency changed.');
      for (const path of Array.isArray(passage.draft_paths) ? passage.draft_paths : []) if (typeof path === 'string') references.add(path);
      for (const key of ['counter_requirements', 'evidence_checks'] as const) {
        for (const child of Array.isArray(passage[key]) ? passage[key] : []) {
          if (record(child) && typeof child.path === 'string') references.add(child.path);
        }
      }
      if (record(passage.source_counter_obligation) && typeof passage.source_counter_obligation.path === 'string') {
        references.add(passage.source_counter_obligation.path);
      }
    }
  }
  if (!Number.isSafeInteger(firstLine) || !Number.isSafeInteger(lastLine) || firstLine < 1 || lastLine < firstLine
    || !categories.size) fail('A finite scoped provider declaration cannot be constructed.');
  const paths = [...references].sort();
  const properties = structuredClone(passageSchema.properties);
  properties.start = {type:'integer',minimum:firstLine,maximum:lastLine};
  properties.end = structuredClone(properties.start);
  properties.draft_paths = paths.length
    ? {type:'array',maxItems:32,items:{type:'string',enum:paths}}
    : {type:'array',maxItems:0,items:{type:'string'}};
  for (const key of ['counter_requirements', 'evidence_checks', 'source_counter_obligation'] as const) {
    const property = properties[key];
    const child = key === 'source_counter_obligation' ? property : record(property) ? property.items : undefined;
    if (!record(child) || !record(child.properties) || !record(child.properties.path)) continue;
    child.properties.path = paths.length
      ? {...child.properties.path,type:'string',enum:paths}
      : {type:'string',maxLength:0};
  }
  const passage = {...structuredClone(passageSchema),properties};
  return {type:'object',additionalProperties:false,required:['scope_digest','parent_digest','context','groups'],properties:{
    scope_digest:{type:'string',enum:[scope.scope_digest]},
    parent_digest:{type:'string',enum:[scope.parent_digest]},
    context:{type:'string',enum:[scope.context]},
    groups:{type:'array',minItems:scope.targets.length,maxItems:scope.targets.length,items:{
      type:'object',additionalProperties:false,required:['target_id','replacements'],properties:{
        target_id:{type:'string',enum:scope.targets.map(target=>target.target_id)},
        replacements:{type:'array',minItems:1,maxItems:MAX_PASSAGES,
          description:'Use the category that matches this exact target. Repeat each read-only overlap dependency unchanged. The host enforces target/category/reference correlation, exact retained records and complete review.',
          items:{type:'object',additionalProperties:false,required:['category','passage'],properties:{
            category:{type:'string',enum:[...categories],
              description:`Category-specific fixed interpretations, when applicable: ${JSON.stringify(categoryMeanings)}. The host checks exact target, category and proof.`},
            passage,
          }},
        },
      },
    }},
  }};
}

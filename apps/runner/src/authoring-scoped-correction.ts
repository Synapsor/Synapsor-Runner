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
  version: 2;
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
type EditableComponent = { path: string; parent_index: number; kind: 'passage' | 'counter_child'; child_index?: number };
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
    const allowedReferences = references(indices.filter(index => located.some(item => item.index === index))
      .map(index => raw.passages[index]!), findings, context, options, receipt);
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
  for (const target of targets) editableComponents(target);
  const base = { version: 2 as const, disposition: 'unaccepted_tentative' as const, context: identity,
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
/** Coordinates come from current host findings, never from a returned model
 * position. A counter child may not be promoted into a paragraph edit. */
function editableComponents(target: CoverageRepairTarget): EditableComponent[] {
  const result: EditableComponent[] = [];
  for (const member of target.members) {
    const findings = target.findings.filter(f => f.component === member.path || f.component.startsWith(`${member.path}/`));
    if (!findings.length) continue;
    const counter = findings.map(f => /^\/passages\/(\d+)\/counter_requirements\/(\d+)$/u.exec(f.component));
    if (counter.some(Boolean)) {
      if (counter.some(match => !match || Number(match[1]) !== member.parent_index)) {
        fail('Overlapping passage and counter-child edits cannot be nominated together.');
      }
      result.push(...counter.map(match => ({path: `${member.path}/counter_requirements/${match![2]}`,
        parent_index: member.parent_index, kind: 'counter_child' as const, child_index: Number(match![2])})));
    } else result.push({path: member.path, parent_index: member.parent_index, kind: 'passage'});
  }
  if (!result.length || new Set(result.map(item => item.path)).size !== result.length) fail('A repair region has no distinct editable component.');
  return result;
}
const passageKeys = ['start', 'end', 'disposition', 'interpretation', 'draft_paths', 'operator_override', 'operator_message_id',
  'operator_clarification', 'topic', 'responsibility', 'issue_kind', 'next_step', 'evidence_checks', 'counter_requirements',
  'field_checks', 'application_obligations', 'deployment_prerequisite', 'source_counter_obligation', 'receipt_component'];
function replacementPassage(value: unknown, category: CoverageRepairCategory, target: CoverageRepairTarget,
  member: CoverageRepairTarget['members'][number], source: PolicyTextSnapshot): RawPassage {
  exactKeys(value, passageKeys, ['start', 'end', 'disposition', 'interpretation', 'draft_paths'], 'Replacement passage');
  if (!range(value, policyTextLines(source.text).length) || value.start < member.start || value.end > member.end) {
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
function replacementCounter(value: unknown, original: unknown, draft: unknown): Record<string, unknown> {
  exactKeys(value, ['path', 'current_capability', 'required_capability', 'operator_message_id', 'operator_clarification'],
    ['path', 'current_capability', 'required_capability'], 'Replacement counter child');
  if (!record(original) || typeof original.path !== 'string' || value.path !== original.path
    || !pointerExists(draft,original.path)) {
    fail('A counter child cannot change its exact nominated current reference.');
  }
  return value;
}
/** Deterministic projection from editable components only. Every other raw
 * parent record, including overlap dependencies, is copied by the host. */
export function assembleScopedCoverageReplacement(scope: CoverageRepairScope, parent: unknown, payload: unknown, context: CoverageRepairContext) {
  checkScope(scope);
  const raw = parentReport(parent, context.source);
  if (scope.context !== contextDigest(context) || scope.source_digest !== context.source.digest
    || scope.source_identity !== canonicalJsonDigest(context.source) || scope.draft_digest !== canonicalJsonDigest(context.draft)) {
    fail('Source, store, subject or prepared context changed since nomination.');
  }
  if (rawDigest(raw) !== scope.parent_digest) fail('The replacement does not use the exact immediate parent.');
  jsonValue(payload, 'Scoped replacement');
  exactKeys(payload, ['representation', 'scope_digest', 'parent_digest', 'context', 'groups'],
    ['representation', 'scope_digest', 'parent_digest', 'context', 'groups'], 'Scoped replacement envelope');
  if (payload.representation !== 'replacement_only_v2' || payload.scope_digest !== scope.scope_digest
    || payload.parent_digest !== scope.parent_digest || payload.context !== scope.context) {
    fail('The replacement names a different scope, parent or context.');
  }
  if (!Array.isArray(payload.groups) || payload.groups.length !== scope.targets.length) fail('Every nominated group must be supplied exactly once.');
  type Fragment = {category: CoverageRepairCategory; passage: RawPassage};
  const passageEdits = new Map<string, Fragment[]>();
  const counterEdits = new Map<string, Record<string, unknown>>();
  const groupsSeen = new Set<string>();
  const overrideDecision=(passage:RawPassage)=>Object.fromEntries(['operator_override','operator_message_id','operator_clarification']
    .filter(key=>Object.hasOwn(passage,key)).map(key=>[key,passage[key]]));
  for (const group of payload.groups) {
    exactKeys(group, ['target_id', 'passage_replacements', 'counter_replacements'],
      ['target_id', 'passage_replacements', 'counter_replacements'], 'Replacement group');
    const target = scope.targets.find(target => target.target_id === group.target_id);
    if (!target || groupsSeen.has(target.target_id)) fail('A replacement group is unrequested or duplicated.');
    groupsSeen.add(target.target_id);
    const editable = editableComponents(target);
    const expectedPassages = editable.filter(item => item.kind === 'passage');
    const expectedCounters = editable.filter(item => item.kind === 'counter_child');
    if (!Array.isArray(group.passage_replacements) || group.passage_replacements.length !== expectedPassages.length
      || !Array.isArray(group.counter_replacements) || group.counter_replacements.length !== expectedCounters.length) {
      fail('Every exact editable component must be supplied once; read-only dependencies are host-retained.');
    }
    for (const edit of group.passage_replacements) {
      exactKeys(edit, ['member_path', 'fragments'], ['member_path', 'fragments'], 'Passage edit');
      const nominated = expectedPassages.find(item => item.path === edit.member_path);
      if (!nominated || passageEdits.has(nominated.path)) fail('A passage edit is protected, foreign or duplicated.');
      const member = target.members.find(item => item.parent_index === nominated.parent_index)!;
      if (!Array.isArray(edit.fragments) || !edit.fragments.length || edit.fragments.length > MAX_PASSAGES) fail('A nominated passage needs bounded replacement fragments.');
      const fragments: Fragment[] = edit.fragments.map((entry:unknown) => {
        exactKeys(entry, ['category', 'passage'], ['category', 'passage'], 'Replacement component');
        const category = entry.category as CoverageRepairCategory;
        if (!COVERAGE_REPAIR_CATEGORIES.includes(category) || (category === 'ordinary') === target.receipt_region) {
          fail('Receipt regions require explicit receipt/effect categories; ordinary is available only for non-receipt regions.');
        }
        return {category, passage: replacementPassage(entry.passage, category, target, member, context.source)};
      });
      if (new Set(fragments.map(entry => rawDigest(entry.passage))).size !== fragments.length) fail('A passage edit repeats the same raw component.');
      const prior = raw.passages[member.parent_index]!;
      for (const entry of fragments) if (['background', 'overridden'].includes(entry.passage.disposition as string)
        && !(rawDigest(prior) === rawDigest(entry.passage)
          || entry.passage.disposition === 'overridden' && prior.disposition === 'overridden'
            && prior.start === entry.passage.start && prior.end === entry.passage.end
            && Object.keys(overrideDecision(prior)).length > 0
            && rawDigest(overrideDecision(prior)) === rawDigest(overrideDecision(entry.passage)))) {
        fail('A replacement cannot create a background or overridden reclassification; only exact existing records may retain those dispositions.');
      }
      for (let line=member.start;line<=member.end;line++) {
        const covering=fragments.filter(entry=>entry.passage.start<=line&&line<=entry.passage.end);
        if (!covering.length) fail('A replacement deletes part of its nominated source requirement.');
        if (!['background','overridden'].includes(prior.disposition as string)
          && !covering.some(entry=>!['background','overridden'].includes(entry.passage.disposition as string))) {
          fail('A substantive parent requirement cannot become only background or overridden.');
        }
      }
      passageEdits.set(nominated.path,fragments);
    }
    for (const edit of group.counter_replacements) {
      exactKeys(edit, ['component_path','counter_requirement'], ['component_path','counter_requirement'], 'Counter-child edit');
      const nominated=expectedCounters.find(item=>item.path===edit.component_path);
      if (!nominated || counterEdits.has(nominated.path)) fail('A counter-child edit is protected, foreign or duplicated.');
      const original=(raw.passages[nominated.parent_index]!.counter_requirements as unknown[])[nominated.child_index!]!;
      counterEdits.set(nominated.path,replacementCounter(edit.counter_requirement,original,context.draft));
    }
  }
  const passages: RawPassage[] = [], mapping: CoverageRepairMapping[] = [];
  const categories: Array<{ index: number; category: CoverageRepairCategory; target_id: string }> = [];
  const retained: Array<{ parent_index: number; assembled_index: number; raw_digest: string }> = [];
  const members = new Map(scope.targets.flatMap(target => target.members.map(member => [member.parent_index,{target,member}] as const)));
  const byTarget = new Map(scope.targets.map(target => [target.target_id,{target_id:target.target_id,
    parent_indices:target.members.map(member=>member.parent_index),assembled_indices:[] as number[],source_ranges:structuredClone(target.source_ranges)}]));
  for (const [index, passage] of raw.passages.entries()) {
    const located=members.get(index);
    if (!located) { retained.push({parent_index:index,assembled_index:passages.length,raw_digest:rawDigest(passage)}); passages.push(structuredClone(passage)); continue; }
    const {target,member}=located, tracked=byTarget.get(target.target_id)!;
    const fragments=passageEdits.get(member.path);
    if (fragments) {
      for (const entry of fragments) {
        tracked.assembled_indices.push(passages.length);
        categories.push({index:passages.length,category:entry.category,target_id:target.target_id});
        passages.push(structuredClone(entry.passage));
      }
      continue;
    }
    const childEdits=editableComponents(target).filter(item=>item.parent_index===index&&item.kind==='counter_child');
    if (childEdits.length) {
      const reconstructed=structuredClone(passage);
      const children=reconstructed.counter_requirements as unknown[];
      for (const edit of childEdits) children[edit.child_index!]=structuredClone(counterEdits.get(edit.path)!);
      tracked.assembled_indices.push(passages.length); passages.push(reconstructed);
      continue;
    }
    if (!target.required_retained.some(item=>item.parent_index===index&&item.raw_digest===rawDigest(passage))) {
      fail('A protected overlap dependency changed in the exact parent.');
    }
    tracked.assembled_indices.push(passages.length);
    retained.push({parent_index:index,assembled_index:passages.length,raw_digest:rawDigest(passage)});
    passages.push(structuredClone(passage));
  }
  mapping.push(...scope.targets.map(target=>byTarget.get(target.target_id)!));
  for (const target of scope.targets) for (const required of target.field_requirements) for (let line=required.start;line<=required.end;line++) {
    if(!byTarget.get(target.target_id)!.assembled_indices.some(index=>{
      const passage=passages[index]!;
      return passage.start<=line&&passage.end>=line&&Array.isArray(passage.field_checks)
        &&passage.field_checks.some(check=>record(check)&&check.resource===required.resource&&check.field===required.field&&check.expectation===required.expectation);
    })) fail('A replacement removes a nominated field requirement or its original source association.');
  }
  if (passages.length > MAX_PASSAGES) fail('The complete assembled report exceeds the existing 120-passage ceiling.');
  const assembled = { passages };
  jsonValue(assembled, 'Complete assembled report');
  if (missingReviewSourceLines(context.source, passages)?.length) fail('The complete assembled report omits source lines.');
  const outsideDigest = rawDigest(retained.filter(item=>!members.has(item.parent_index)).map(item=>passages[item.assembled_index]));
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
  const parent=scopeParents.get(scope);
  if (!parent) fail('The exact immediate parent is unavailable for the scoped provider request.');
  const counterSchema=record(passageSchema.properties) && record(passageSchema.properties.counter_requirements)
    ? passageSchema.properties.counter_requirements.items : undefined;
  const groupVariants=scope.targets.map(target=>{
    const editable=editableComponents(target);
    const passageTargets=editable.filter(item=>item.kind==='passage');
    const counterTargets=editable.filter(item=>item.kind==='counter_child');
    const fragmentVariants=COVERAGE_REPAIR_CATEGORIES.filter(category=>(category==='ordinary')!==target.receipt_region)
      .map(category=>{
        const properties=structuredClone(record(passageSchema.properties)?passageSchema.properties:{});
        properties.start={type:'integer',minimum:target.source_ranges[0]!.start,maximum:target.source_ranges[0]!.end};
        properties.end=structuredClone(properties.start);
        properties.draft_paths=target.allowed_references[category].length
          ? {type:'array',maxItems:32,items:{type:'string',enum:target.allowed_references[category]}}
          : {type:'array',maxItems:0,items:{type:'string'}};
        for(const key of ['counter_requirements','evidence_checks','source_counter_obligation']){
          const property=properties[key];
          const child=key==='source_counter_obligation'?property:record(property)?property.items:undefined;
          if(!record(child)||!record(child.properties)||!record(child.properties.path))continue;
          const existing=child.properties.path.enum;
          const permitted=target.allowed_references[category].filter(path=>!Array.isArray(existing)||existing.includes(path));
          if(!permitted.length)delete properties[key];
          else child.properties.path={...child.properties.path,type:'string',enum:permitted};
        }
        if(record(properties.field_checks)){
          const checks=target.field_requirements.map(({resource,field,expectation})=>({resource,field,expectation}));
          if(!checks.length)delete properties.field_checks;
          else properties.field_checks={...properties.field_checks,items:{enum:checks}};
        }
        if(category==='source_transaction_coupling')properties.receipt_component={type:'string',const:category};
        else delete properties.receipt_component;
        return {type:'object',additionalProperties:false,required:['category','passage'],properties:{
          category:{type:'string',const:category},passage:{...structuredClone(passageSchema),properties,
            ...(category==='source_transaction_coupling'
              ? {required:[...new Set([...(Array.isArray(passageSchema.required)?passageSchema.required:[]),'receipt_component'])]} : {})},
        }};
      });
    const passageVariants=passageTargets.map(item=>{
      const member=target.members.find(member=>member.parent_index===item.parent_index)!;
      return {type:'object',additionalProperties:false,required:['member_path','fragments'],properties:{
        member_path:{type:'string',const:item.path},fragments:{type:'array',minItems:1,maxItems:MAX_PASSAGES,
          items:{oneOf:fragmentVariants.map(variant=>{
            const copy=structuredClone(variant);
            copy.properties.passage.properties.start={type:'integer',minimum:member.start,maximum:member.end};
            copy.properties.passage.properties.end=structuredClone(copy.properties.passage.properties.start);
            return copy;
          })}},
      }};
    });
    const counterVariants=counterTargets.map(item=>{
      if(!record(counterSchema))fail('A typed counter-child declaration is unavailable.');
      const original=(parent.passages[item.parent_index]!.counter_requirements as unknown[])[item.child_index!];
      if(!record(original)||typeof original.path!=='string')fail('A nominated counter child is unavailable in the immediate parent.');
      const copy=structuredClone(counterSchema);
      if(!record(copy.properties)||!record(copy.properties.path))fail('The counter-child declaration has no typed reference.');
      copy.properties.path={...copy.properties.path,type:'string',const:original.path};
      return {type:'object',additionalProperties:false,required:['component_path','counter_requirement'],properties:{
        component_path:{type:'string',const:item.path},counter_requirement:copy,
      }};
    });
    return {type:'object',additionalProperties:false,required:['target_id','passage_replacements','counter_replacements'],properties:{
      target_id:{type:'string',const:target.target_id},
      passage_replacements:{type:'array',minItems:passageTargets.length,maxItems:passageTargets.length,
        items:passageVariants.length?{oneOf:passageVariants}:false},
      counter_replacements:{type:'array',minItems:counterTargets.length,maxItems:counterTargets.length,
        items:counterVariants.length?{oneOf:counterVariants}:false},
    }};
  });
  return {type:'object',additionalProperties:false,
    required:['representation','scope_digest','parent_digest','context','groups'],properties:{
      representation:{type:'string',const:'replacement_only_v2'},
      scope_digest:{type:'string',const:scope.scope_digest},parent_digest:{type:'string',const:scope.parent_digest},
      context:{type:'string',const:scope.context},groups:{type:'array',minItems:scope.targets.length,maxItems:scope.targets.length,
        items:{oneOf:groupVariants}},
    }};
}

/** A closed typed structural superset for the selected nonstrict function-tool
 * route. Exact target/member/category correlations remain host-enforced. */
export function portableScopeToolSchema(scope: CoverageRepairScope, passageSchema: Record<string, unknown>,
  constrainedSchema: Record<string, unknown>): Record<string, unknown> {
  checkScope(scope);
  if(!scope.targets.length||!record(passageSchema.properties)||!Array.isArray(passageSchema.required)
    ||passageSchema.type!=='object'||passageSchema.additionalProperties!==false){
    fail('A bounded, closed passage declaration is unavailable for the scoped provider request.');
  }
  const parent=scopeParents.get(scope);
  if(!parent)fail('The exact immediate parent is unavailable for the scoped provider request.');
  const groups=record(constrainedSchema.properties)&&record(constrainedSchema.properties.groups)
    &&record(constrainedSchema.properties.groups.items)?constrainedSchema.properties.groups.items.oneOf:undefined;
  if(!Array.isArray(groups)||groups.length!==scope.targets.length)fail('The exact constrained correction variants are unavailable.');
  const categoryMeanings:Record<string,string[]>={};
  for(const [index,variant] of groups.entries()){
    if(!record(variant)||!record(variant.properties)||!record(variant.properties.target_id)
      ||variant.properties.target_id.const!==scope.targets[index]!.target_id
      ||!record(variant.properties.passage_replacements)
      ||(editableComponents(scope.targets[index]!).some(item=>item.kind==='passage')
        &&(!record(variant.properties.passage_replacements.items)||!Array.isArray(variant.properties.passage_replacements.items.oneOf)))){
      fail('The constrained correction variants no longer match the nominated targets.');
    }
    const passageVariants=record(variant.properties.passage_replacements.items)
      &&Array.isArray(variant.properties.passage_replacements.items.oneOf)
      ?variant.properties.passage_replacements.items.oneOf:[];
    for(const passageVariant of passageVariants){
      const fragments=record(passageVariant)&&record(passageVariant.properties)
        &&record(passageVariant.properties.fragments)&&record(passageVariant.properties.fragments.items)
        ?passageVariant.properties.fragments.items.oneOf:undefined;
      if(!Array.isArray(fragments))continue;
      for(const alternative of fragments){
        if(!record(alternative)||!record(alternative.properties)||!record(alternative.properties.category)
          ||!record(alternative.properties.passage))continue;
        const category=alternative.properties.category.const;
        const meaning=record(alternative.properties.passage.properties)
          &&record(alternative.properties.passage.properties.interpretation)
          ?alternative.properties.passage.properties.interpretation.enum:undefined;
        if(typeof category==='string'&&Array.isArray(meaning)&&meaning.every(item=>typeof item==='string')){
          categoryMeanings[category]=[...new Set([...(categoryMeanings[category]??[]),...meaning])];
        }
      }
    }
  }
  const categories=new Set<CoverageRepairCategory>(),references=new Set<string>();
  const passagePaths:string[]=[],counterPaths:string[]=[],counterReferences:string[]=[];
  let firstLine=Infinity,lastLine=0,maxPassages=0,maxCounters=0;
  for(const target of scope.targets){
    const editable=editableComponents(target);
    const passages=editable.filter(item=>item.kind==='passage'),counters=editable.filter(item=>item.kind==='counter_child');
    maxPassages=Math.max(maxPassages,passages.length);maxCounters=Math.max(maxCounters,counters.length);
    passagePaths.push(...passages.map(item=>item.path));counterPaths.push(...counters.map(item=>item.path));
    for(const item of counters){
      const original=(parent.passages[item.parent_index]!.counter_requirements as unknown[])[item.child_index!];
      if(!record(original)||typeof original.path!=='string')fail('A nominated counter child is unavailable.');
      counterReferences.push(original.path);
    }
    for(const item of passages){
      const member=target.members.find(member=>member.parent_index===item.parent_index)!;
      firstLine=Math.min(firstLine,member.start);lastLine=Math.max(lastLine,member.end);
    }
    for(const category of COVERAGE_REPAIR_CATEGORIES){
      if((category==='ordinary')===target.receipt_region)continue;
      categories.add(category);
      for(const path of target.allowed_references[category])references.add(path);
    }
  }
  if(!passagePaths.length&&!counterPaths.length||!categories.size)fail('A finite scoped provider declaration cannot be constructed.');
  const paths=[...references].sort();
  const properties=structuredClone(passageSchema.properties);
  if(passagePaths.length){
    properties.start={type:'integer',minimum:firstLine,maximum:lastLine};properties.end=structuredClone(properties.start);
  }
  properties.draft_paths=paths.length?{type:'array',maxItems:32,items:{type:'string',enum:paths}}
    :{type:'array',maxItems:0,items:{type:'string'}};
  for(const key of ['counter_requirements','evidence_checks','source_counter_obligation'] as const){
    const property=properties[key];
    const child=key==='source_counter_obligation'?property:record(property)?property.items:undefined;
    if(!record(child)||!record(child.properties)||!record(child.properties.path))continue;
    child.properties.path=paths.length?{...child.properties.path,type:'string',enum:paths}:{type:'string',maxLength:0};
  }
  const counterProperty=passageSchema.properties.counter_requirements;
  const counterSchema=record(counterProperty)&&record(counterProperty.items)?structuredClone(counterProperty.items):undefined;
  if(counterPaths.length&&(!record(counterSchema)||!record(counterSchema.properties)||!record(counterSchema.properties.path))){
    fail('A typed counter-child declaration is unavailable for the scoped provider request.');
  }
  if(counterSchema&&record(counterSchema.properties))counterSchema.properties.path=counterReferences.length
    ?{type:'string',enum:[...new Set(counterReferences)].sort()}:{type:'string',maxLength:0};
  const passage={...structuredClone(passageSchema),properties};
  return {type:'object',additionalProperties:false,
    required:['representation','scope_digest','parent_digest','context','groups'],properties:{
      representation:{type:'string',enum:['replacement_only_v2']},scope_digest:{type:'string',enum:[scope.scope_digest]},
      parent_digest:{type:'string',enum:[scope.parent_digest]},context:{type:'string',enum:[scope.context]},
      groups:{type:'array',minItems:scope.targets.length,maxItems:scope.targets.length,items:{
        type:'object',additionalProperties:false,required:['target_id','passage_replacements','counter_replacements'],properties:{
          target_id:{type:'string',enum:scope.targets.map(target=>target.target_id)},
          passage_replacements:{type:'array',minItems:0,maxItems:maxPassages,
            description:'Only exact host-nominated editable parent passages. Never echo read-only overlap dependencies.',
            items:{type:'object',additionalProperties:false,required:['member_path','fragments'],properties:{
              member_path:passagePaths.length?{type:'string',enum:passagePaths}:{type:'string',maxLength:0},fragments:{type:'array',minItems:1,maxItems:MAX_PASSAGES,
                items:{type:'object',additionalProperties:false,required:['category','passage'],properties:{
                  category:{type:'string',enum:[...categories],description:`Fixed category meanings when applicable: ${JSON.stringify(categoryMeanings)}. The host checks exact target, category and proof.`},
                  passage,
                }}},
            }}},
          counter_replacements:{type:'array',minItems:0,maxItems:maxCounters,
            description:'Only exact nominated counter children. Runner retains the enclosing passage and every sibling.',
            items:{type:'object',additionalProperties:false,required:['component_path','counter_requirement'],properties:{
              component_path:counterPaths.length?{type:'string',enum:counterPaths}:{type:'string',maxLength:0},
              counter_requirement:counterSchema??{type:'object',additionalProperties:false,maxProperties:0},
            }}},
        },
      }},
    }};
}

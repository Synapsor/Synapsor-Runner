import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { collectCoverageFeedback, parsePolicyCoverage, reviewPolicyCoverage } from './authoring-policy-coverage.js';
import { permitsSecondCoverageCorrection } from './authoring-coverage-feedback.js';
import { createCoverageRepairScope, assembleScopedCoverageReplacement, type CoverageRepairScope } from './authoring-scoped-correction.js';
import { receiptComponentMeanings, validateScopedReceiptComponents } from './authoring-scoped-receipt-components.js';
import { receiptCouplingInterpretation, receiptCouplingPaths } from './authoring-obligation-review.js';
import { configuredCountingLimits } from './authoring-counting-requirements.js';
import { createModelAuthoringConversation } from './model-authoring-conversation.js';
import { secureAskJsonRequest } from './model-ask.js';
import { ensurePreparedPolicyCoverage } from './authoring-prepared-policy-review.js';
import { createBoundaryReviewInteractiveSession } from './boundary-cli-picker.js';
import { authoringDestination, loadPolicySources, savePolicySources } from './authoring-policy-source.js';
import { policyReadinessItems, policyReviewReadiness } from './authoring-review-readiness.js';
import * as receiptConfiguration from './authoring-receipt-configuration.js';

// Authentic latest paid 31/37 reports and their own prepared context. Every
// synthetic repair below is labelled DERIVED; neither historical reply is fixed.
const captured = JSON.parse(await fs.readFile(new URL('./test-fixtures/scoped-review-correction.json', import.meta.url), 'utf8'));
const fixture = (): any => structuredClone(captured);
const CONFIG = '/runner_evidence/runtime_contract/receipt_configuration';
const EXCLUSION = '/runner_evidence/runtime_contract/receipt_read_exclusion';
const RECEIPTS = '/runner_evidence/runtime_contract/receipts';
const rawDigest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const context = (f: any) => ({ source: f.source, draft: f.draft, messages: f.operator_messages });
const parse = (f: any, args: Record<string, unknown>) => parsePolicyCoverage(args, f.source, f.draft, f.operator_messages);
function scopeFor(f: any): CoverageRepairScope {
  return createCoverageRepairScope(f.arguments, collectCoverageFeedback(f.arguments, f.source, f.draft, f.operator_messages), context(f));
}
function requestScope(body: any): CoverageRepairScope {
  const marker = 'Host repair scope (identities and exact references, not authority): ';
  const messages = (body.messages ?? body.input).map((m: any) => m.content).filter((value: any) => typeof value === 'string').join('\n');
  const line = messages.split('\n').find((value: string) => value.startsWith(marker));
  if (!line) throw new Error('Actual outgoing request did not contain a host repair scope');
  return JSON.parse(line.slice(marker.length));
}
function derivedReplacement(f: any, scope: CoverageRepairScope): any {
  const outcome = f.draft.actions[0].outcome, meanings = receiptComponentMeanings(f.draft);
  const passage = (category: 'compiled_effect' | 'receipt_configuration' | 'receipt_read_exclusion', draft_paths: string[]) => ({
    category, passage: { start: 18, end: 18, disposition: 'implemented', responsibility: 'runner', issue_kind: 'coverage_link',
      interpretation: meanings[category]![0], draft_paths },
  });
  return { scope_digest: scope.scope_digest, parent_digest: scope.parent_digest, context: scope.context,
    groups: scope.targets.map(target => ({ target_id: target.target_id, replacements: [
      passage('compiled_effect', [receiptCouplingPaths(outcome)[0]!]),
      passage('receipt_configuration', [CONFIG]),
      { category: 'source_transaction_coupling', passage: { start: 18, end: 18, disposition: 'implemented', responsibility: 'runner',
        issue_kind: 'coverage_link', receipt_component: 'source_transaction_coupling',
        interpretation: receiptCouplingInterpretation(outcome), draft_paths: receiptCouplingPaths(outcome) } },
      passage('receipt_read_exclusion', [EXCLUSION]),
      // Dependency closure includes the two existing line-18 pending setup
      // passages. Preserve their complete text/fields, not weaker new duties.
      ...target.members.filter(member => member.parent_index !== 24).map(member => ({
        category: 'setup', passage: structuredClone(f.arguments.passages[member.parent_index]),
      })),
    ] })) };
}
function derivedAssembly(f: any) {
  const scope = scopeFor(f), replacement = derivedReplacement(f, scope);
  const result = assembleScopedCoverageReplacement(scope, f.arguments, replacement, context(f));
  validateScopedReceiptComponents(result.assembled, result.categories, scope, f.source, f.draft);
  return { scope, replacement, ...result };
}
type Reply = any | ((body: any, number: number) => any);
function transport(f: any, replies: Reply[], provider: 'openai' | 'openrouter' = 'openrouter') {
  const conversation = createModelAuthoringConversation(); conversation.policySources = f.sources;
  const requests: any[] = [];
  const session = { provider, model: provider === 'openai' ? 'gpt-5.6-terra' : 'openai/gpt-5.6-terra', apiKey: 'local-only', conversation,
    dependencies: { requestJson: vi.fn(async (request: any): Promise<any> => {
      requests.push(structuredClone(request.body));
      const reply = replies[requests.length - 1];
      if (reply instanceof Error) throw reply;
      const args = typeof reply === 'function' ? await reply(request.body, requests.length) : reply;
      if (!args) throw new Error('No further local response authorized');
      return { status: 200, body: provider === 'openai'
        ? { output: [{ type: 'function_call', call_id: 'derived-local', name: 'runner__review_policy_coverage', arguments: JSON.stringify(args) }] }
        : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'derived-local', type: 'function',
          function: { name: 'runner__review_policy_coverage', arguments: JSON.stringify(args) } }] } }] } };
    }) } };
  f.sources.approvals.push({ digest: f.source.digest, destination: authoringDestination(session) });
  return { session, requests, run: () => reviewPolicyCoverage({ session, source: f.source, draft: f.draft }) };
}
const correctedReplies = (f: any): Reply[] => [f.arguments, (body: any) => derivedReplacement(f, requestScope(body))];

describe('latest actual report and host-scoped DERIVED lineage', () => {
  it('keeps actual 31 and 37 submissions invalid and reproduces the original no-progress comparison', () => {
    const f = fixture(), before = rawDigest(f);
    expect(f.arguments.passages).toHaveLength(31); expect(f.actual_correction.passages).toHaveLength(37);
    expect(f.arguments.passages[21].counter_requirements.every((p: any) => !Object.hasOwn(p, 'operator_message_id'))).toBe(true);
    expect(() => parse(f, f.arguments)).toThrow(); expect(() => parse(f, f.actual_correction)).toThrow();
    const first = collectCoverageFeedback(f.arguments, f.source, f.draft, f.operator_messages);
    const second = collectCoverageFeedback(f.actual_correction, f.source, f.draft, f.operator_messages);
    expect(first.findings).toHaveLength(1); expect(first.findings[0]).toMatchObject({ component: '/passages/24', structural: true });
    expect(second.findings.filter(finding => finding.code === 'COUNTING_SUPPORT_MISMATCH')).toHaveLength(2);
    expect(second.findings.some(finding => finding.code === 'OBLIGATION_OBSERVATION_UNESTABLISHED')).toBe(true);
    expect(permitsSecondCoverageCorrection([first], second)).toBe(false);
    expect(rawDigest(f)).toBe(before);
  });

  it('assembles the complete latest parent, preserving outside bytes, optional-field absence and all pending setup', () => {
    const f = fixture(), before = rawDigest(f), result = derivedAssembly(f), report = parse(f, result.assembled);
    expect(result.scope.targets).toHaveLength(1);
    expect(result.scope.targets[0]!.members.map(m => m.parent_index)).toEqual([24, 25, 26]);
    expect(result.scope.targets[0]!.source_ranges).toEqual([{ start: 18, end: 18 }]);
    expect(result.assembled.passages).toHaveLength(34); expect(result.retained).toHaveLength(28);
    for (const entry of result.retained) expect(JSON.stringify(result.assembled.passages[entry.assembled_index])).toBe(JSON.stringify(f.arguments.passages[entry.parent_index]));
    expect(rawDigest(result.retained.map(entry => result.assembled.passages[entry.assembled_index]))).toBe(result.scope.outside_digest);
    expect(result.assembled.passages.slice(28, 30)).toEqual(f.arguments.passages.slice(25, 27));
    expect(result.assembled.passages[21]!.counter_requirements).toEqual(f.arguments.passages[21].counter_requirements);
    expect(report.counting_inventory?.paths).toHaveLength(2);
    expect(report.passages.some(p => p.receipt_component === 'source_transaction_coupling')).toBe(true);
    expect(report.passages.filter(p => p.obligation_assessment).every(p => p.obligation_assessment!.verified === false)).toBe(true);
    expect(report.passages.some(p => p.application_obligations?.includes('independent_source_readback'))).toBe(true);
    expect(policyReadinessItems(report, f.sources).filter(item => item.blocksReview).every(item => Boolean(item.clientDuty))).toBe(true);
    expect(result.audit).toMatchObject({ disposition: 'unaccepted_tentative', raw_parent: f.arguments, raw_replacement: result.replacement, assembled: result.assembled });
    expect(rawDigest(f)).toBe(before);
  });

  it.each(['openai', 'openrouter'] as const)('%s uses its real encoder and exposes only the nominated replacement contract', async provider => {
    const f = fixture(), t = transport(f, correctedReplies(f), provider);
    const report = await t.run(); expect(t.requests).toHaveLength(2);
    const scope = requestScope(t.requests[1]);
    expect(scope.parent_digest).toBe(rawDigest(f.arguments)); expect(scope.targets[0]!.members.map(m => m.parent_index)).toEqual([24, 25, 26]);
    const tool = t.requests[1].tools.find((entry: any) => (entry.name ?? entry.function?.name) === 'runner__review_policy_coverage');
    const schema = tool.parameters ?? tool.function.parameters;
    expect(schema.additionalProperties).toBe(false); expect(Object.keys(schema.properties).sort()).toEqual(['context', 'groups', 'parent_digest', 'scope_digest']);
    expect(report.passages).toHaveLength(34); expect(report.counting_inventory?.paths).toHaveLength(2);
  });

  it('refuses the unchanged actual unsolicited 37-passage correction without a third call or cleaning its counters', async () => {
    const f = fixture(), t = transport(f, [f.arguments, f.actual_correction, ...correctedReplies(f)]);
    await expect(t.run()).rejects.toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED'); expect(t.requests).toHaveLength(2);
    expect(f.actual_correction.passages.flatMap((p: any) => p.counter_requirements ?? []).map((p: any) => p.operator_message_id)).toEqual([2, 2]);
  });

  it.each(['counter_record', 'counter_field', 'extra_path', 'outside_field', 'outside_target', 'missing_target', 'duplicate_target', 'wrong_parent', 'wrong_scope', 'wrong_context', 'wrong_span', 'empty_group'])(
    'refuses %s in the actual correction producer', async mode => {
      const f = fixture(), t = transport(f, [f.arguments, (body: any) => {
        const replacement = derivedReplacement(f, requestScope(body)), group = replacement.groups[0], component = group.replacements[0];
        if (mode === 'counter_record') group.replacements.push({ category: 'compiled_effect', passage: { ...f.arguments.passages[21], operator_message_id: 2 } });
        if (mode === 'counter_field') component.passage.counter_requirements = structuredClone(f.actual_correction.passages.find((p: any) => p.counter_requirements).counter_requirements);
        if (mode === 'extra_path') component.passage.draft_paths.push('/actions/0/approval');
        if (mode === 'outside_field') replacement.passages = [f.arguments.passages[21]];
        if (mode === 'outside_target') group.target_id = canonicalJsonDigest('unrequested counter target');
        if (mode === 'missing_target') replacement.groups = [];
        if (mode === 'duplicate_target') replacement.groups.push(structuredClone(group));
        if (mode === 'wrong_parent') replacement.parent_digest = canonicalJsonDigest(f.actual_correction);
        if (mode === 'wrong_scope') replacement.scope_digest = canonicalJsonDigest('wrong');
        if (mode === 'wrong_context') replacement.context = canonicalJsonDigest('another store');
        if (mode === 'wrong_span') component.passage.start = component.passage.end = 15;
        if (mode === 'empty_group') group.replacements = [];
        return replacement;
      }]);
      await expect(t.run()).rejects.toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED'); expect(t.requests).toHaveLength(2);
    });

  it.each(['category', 'no_coupling', 'split_reordered_unresolved', 'false_receipt', 'false_readback', 'setup_observed', 'omitted_setup', 'weakened_setup', 'duplicated_setup', 'reclassified_setup', 'wrong_role', 'missing_role', 'child_root', 'duplicate_root'])(
    'rejects %s without certifying individually plausible fragments', async mode => {
      const f = fixture(), t = transport(f, [f.arguments, (body: any) => {
        const replacement = derivedReplacement(f, requestScope(body)), entries = replacement.groups[0].replacements;
        const coupling = entries.find((entry: any) => entry.category === 'source_transaction_coupling');
        if (mode === 'category') entries[1].category = 'compiled_effect';
        if (mode === 'no_coupling') replacement.groups[0].replacements = entries.filter((entry: any) => entry !== coupling);
        if (mode === 'split_reordered_unresolved') replacement.groups[0].replacements = [...entries.filter((entry: any) => entry !== coupling), structuredClone(entries[0])].reverse();
        if (mode === 'false_receipt') coupling.passage.interpretation += ' The receipt was observed.';
        if (mode === 'false_readback') entries[1].passage.interpretation += ' Independent source readback verified completion.';
        if (mode === 'setup_observed') entries.at(-1).passage.disposition = 'implemented';
        if (mode === 'omitted_setup') replacement.groups[0].replacements = entries.filter((entry: any) => entry.category !== 'setup');
        if (mode === 'weakened_setup') entries.at(-1).passage.interpretation = 'Writer setup is optional and already provisioned.';
        if (mode === 'duplicated_setup') entries.push(structuredClone(entries.at(-1)));
        if (mode === 'reclassified_setup') { entries.at(-1).passage.disposition = 'background'; entries.at(-1).passage.draft_paths = []; }
        if (mode === 'wrong_role') coupling.passage.responsibility = 'deployment';
        if (mode === 'missing_role') delete coupling.passage.responsibility;
        if (mode === 'child_root') coupling.passage.draft_paths[0] += '/transaction';
        if (mode === 'duplicate_root') coupling.passage.draft_paths.push(coupling.passage.draft_paths[0]);
        return replacement;
      }]);
      await expect(t.run()).rejects.toThrow(); expect(t.requests).toHaveLength(2);
    });

  it.each(['heading', 'definition', 'condition', 'false_evidence'])('retained %s invalidity cannot become accepted through receipt repair', async mode => {
    const f = fixture();
    if (mode === 'false_evidence') f.arguments.passages[14].evidence_checks = [{ path: '/read/source', equals: 'foreign source' }];
    else { const line = mode === 'heading' ? 17 : mode === 'definition' ? 4 : 10; f.arguments.passages = f.arguments.passages.filter((p: any) => !(p.start <= line && p.end >= line)); }
    const t = transport(f, correctedReplies(f)); await expect(t.run()).rejects.toThrow(); expect(t.requests).toHaveLength(1);
  });

  it('a complete valid initial report remains the normal one-response route', async () => {
    const f = fixture(), complete = derivedAssembly(f).assembled, t = transport(f, [complete]);
    await t.run(); expect(t.requests).toHaveLength(1);
  });

  it('renamed Action identity preserves the complete proof and scoped transport', async () => {
    const f = JSON.parse(JSON.stringify(fixture()).replaceAll('energy_ops.finalize_settlement_cycle', 'cooperative.close_period'));
    // This separate synthetic renamed control must rebind its retained explicit
    // counting decisions to the mechanically renamed configuration. It is not
    // the authentic positive lineage above or a new owner answer.
    for (const decision of f.draft.runner_evidence.counting_decisions) {
      decision.configuration_digest = configuredCountingLimits(f.draft).find(limit => limit.path === decision.path)!.digest;
      decision.operator_history_digest = canonicalJsonDigest(f.operator_messages);
    }
    const t = transport(f, correctedReplies(f)); const report = await t.run();
    expect(t.requests).toHaveLength(2); expect(report.passages.find(p => p.receipt_component)?.interpretation).toContain('cooperative.close_period');
  });
});

async function prepared(replies: (f: any) => Reply[] = correctedReplies) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-review-composed-')), f = fixture(), t = transport(f, replies(f));
  vi.spyOn(receiptConfiguration, 'authoringReceiptConfiguration').mockImplementation(async () => structuredClone(f.draft.runner_evidence.runtime_contract.receipt_configuration));
  await savePolicySources(root, f.sources);
  const input = { projectRoot: root, sources: f.sources, modelSession: t.session,
    operatorSession: { chooseOption: vi.fn(async () => 'assign'), confirm: vi.fn(async () => true) } as any,
    currentDraft: () => f.draft, authorityDigest: f.sources.coverage_authority_digest, clarifications: [],
    assertCurrent: async () => {}, state: {}, force: true, onValidated: vi.fn() };
  return { root, f, t, input };
}

function localTerminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  const output = new PassThrough() as PassThrough & WriteStream;
  Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
  let screen = ''; output.on('data', chunk => { screen += chunk.toString(); });
  return { input, output, session: createBoundaryReviewInteractiveSession(input as unknown as ReadStream, output), screen: () => screen };
}

describe('latest scoped report through real HTTP/SSE and coordinated persistence', () => {
  it('requires saved-review episode consent even when historical episodes have a different context', async () => {
    const x = await prepared();
    try {
      x.f.sources.coverage_episodes = [{ id: '00000000-0000-4000-8000-000000000001', context: canonicalJsonDigest('prior context'),
        started_at: '2026-09-22T00:00:00.000Z', submissions: [{ number: 1, reserved_at: '2026-09-22T00:00:00.000Z' }] }];
      await savePolicySources(x.root, x.f.sources);
      const before = structuredClone(await loadPolicySources(x.root, x.f.sources.id));
      const terminal = localTerminal();
      const review = ensurePreparedPolicyCoverage({ ...x.input,
        operatorSession: { ...x.input.operatorSession, confirm: terminal.session.confirm },
        savedReviewEpisode: { job: 'saved review', subject: 'active published Action', },
      } as any);
      await vi.waitFor(() => expect(terminal.screen()).toContain('Run a new bounded model review?'));
      expect(terminal.screen()).toContain('Selected model: openrouter[openai/gpt-5.6-terra]');
      expect(terminal.screen()).toContain('three model response submissions');
      expect(terminal.screen()).toContain('[y/N]');
      terminal.input.emit('keypress', '\r', { name: 'return', sequence: '\r' });
      await expect(review).rejects.toThrow('POLICY_COVERAGE_EPISODE_PENDING');
      expect(x.t.requests).toHaveLength(0);
      expect(await loadPolicySources(x.root, x.f.sources.id)).toEqual(before);
    } finally { vi.restoreAllMocks(); await fs.rm(x.root, { recursive: true, force: true }); }
  });

  it.each(['no', 'escape', 'eof', 'ctrl-c'] as const)('%s cancels a different-context saved episode before reservation or send', async mode => {
    const x = await prepared();
    try {
      x.f.sources.coverage_episodes = [{ id: '00000000-0000-4000-8000-000000000002', context: canonicalJsonDigest('older episode'),
        started_at: '2026-09-22T00:00:00.000Z', submissions: [] }];
      await savePolicySources(x.root, x.f.sources);
      const before = structuredClone(await loadPolicySources(x.root, x.f.sources.id)), terminal = localTerminal();
      const review = ensurePreparedPolicyCoverage({ ...x.input,
        operatorSession: { ...x.input.operatorSession, confirm: terminal.session.confirm },
        savedReviewEpisode: { job: 'saved review', subject: 'active published Action' },
      });
      await vi.waitFor(() => expect(terminal.screen()).toContain('Run a new bounded model review?'));
      if (mode === 'eof') terminal.input.end();
      else terminal.input.emit('keypress', mode === 'escape' ? '\u001b' : mode === 'ctrl-c' ? '\u0003' : 'n',
        { name: mode === 'escape' ? 'escape' : mode === 'ctrl-c' ? 'c' : 'n', sequence: mode === 'escape' ? '\u001b' : mode === 'ctrl-c' ? '\u0003' : 'n', ctrl: mode === 'ctrl-c' });
      await expect(review).rejects.toThrow('POLICY_COVERAGE_EPISODE_PENDING');
      expect(x.t.requests).toHaveLength(0);
      expect(await loadPolicySources(x.root, x.f.sources.id)).toEqual(before);
    } finally { vi.restoreAllMocks(); await fs.rm(x.root, { recursive: true, force: true }); }
  });

  it('a single explicit saved-review Yes precedes the local transport and covers eligible corrections', async () => {
    const x = await prepared(), terminal = localTerminal();
    try {
      const before = (await loadPolicySources(x.root, x.f.sources.id)).coverage_episodes?.length ?? 0;
      const review = ensurePreparedPolicyCoverage({ ...x.input,
        operatorSession: { ...x.input.operatorSession, confirm: terminal.session.confirm },
        savedReviewEpisode: { job: 'saved review', subject: 'active published Action' },
      });
      await vi.waitFor(() => expect(terminal.screen()).toContain('Run a new bounded model review?'));
      expect(x.t.requests).toHaveLength(0);
      terminal.input.emit('keypress', 'y', { name: 'y', sequence: 'y' });
      expect((await review).activity).toBe('provider');
      expect(x.t.requests).toHaveLength(2);
      const saved = await loadPolicySources(x.root, x.f.sources.id);
      expect(saved.coverage_episodes).toHaveLength(before + 1);
      expect(saved.coverage_episodes!.at(-1)!.submissions).toHaveLength(2);
      expect(terminal.screen().match(/Run a new bounded model review\?/gu)).toHaveLength(1);
      x.t.session.conversation.policySources = saved;
      const reused = await ensurePreparedPolicyCoverage({ ...x.input, sources: saved, state: {}, force: false,
        savedReviewEpisode: { job: 'saved review', subject: 'active published Action' } });
      expect(reused.activity).toBe('validated_reuse');
      expect(x.t.requests).toHaveLength(2);
    } finally { vi.restoreAllMocks(); await fs.rm(x.root, { recursive: true, force: true }); }
  });

  it.each(['target', 'provider', 'source'] as const)('%s drift while awaiting Yes cannot allocate or send', async mode => {
    const x = await prepared();
    try {
      const before = structuredClone(await loadPolicySources(x.root, x.f.sources.id));
      const review = ensurePreparedPolicyCoverage({ ...x.input,
        savedReviewEpisode: { job: 'saved review', subject: 'active published Action' },
        operatorSession: { ...x.input.operatorSession, confirm: async () => {
          if (mode === 'target') x.f.draft.actions[0].discovery.title = 'changed target';
          if (mode === 'provider') x.t.session.model = 'different-model';
          if (mode === 'source') await savePolicySources(x.root, { ...x.f.sources, operator_messages: [...x.f.sources.operator_messages, 'concurrent operator decision'] });
          return true;
        } },
      });
      await expect(review).rejects.toThrow(mode === 'source' ? 'POLICY_SOURCE_CHANGED' : 'POLICY_COVERAGE_CONTEXT_CHANGED');
      expect(x.t.requests).toHaveLength(0);
      const after = await loadPolicySources(x.root, x.f.sources.id);
      expect(after.coverage_episodes).toEqual(before.coverage_episodes);
      if (mode !== 'source') expect(after).toEqual(before);
    } finally { vi.restoreAllMocks(); await fs.rm(x.root, { recursive: true, force: true }); }
  });

  it.each(['openai', 'openrouter'] as const)('%s streams actual scope to DERIVED reply, strictly saves, reloads and rechecks', async provider => {
    const x = await prepared(), wire: any[] = [], events: any[] = [], replies: any[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); wire.push(body);
      const args = wire.length === 1 ? x.f.arguments : derivedReplacement(x.f, requestScope(body)); replies.push(structuredClone(args));
      response.setHeader('content-type', 'text/event-stream');
      if (provider === 'openai') {
        response.write(`data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', name: 'runner__review_policy_coverage' } })}\n\n`);
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'derived-local', name: 'runner__review_policy_coverage', arguments: JSON.stringify(args) }] } })}\n\n`);
      } else {
        const text = JSON.stringify(args), middle = Math.floor(text.length / 2);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-private-local-continuation', index: 0 }], tool_calls: [{ index: 0, id: 'derived-local', type: 'function', function: { name: 'runner__review_policy_coverage', arguments: text.slice(0, middle) } }] } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(middle) } }] } }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      }
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local address missing');
      const session = { ...x.t.session, provider, model: provider === 'openai' ? 'gpt-5.6-terra' : 'openai/gpt-5.6-terra', dependencies: {
        requestJson: (request: any) => secureAskJsonRequest({ ...request, headers: {}, endpoint: new URL(`http://127.0.0.1:${address.port}/review`), scope: 'custom_loopback' }),
        onStream: (event: any) => events.push(event),
      } };
      x.f.sources.approvals.push({ digest: x.f.source.digest, destination: authoringDestination(session) }); await savePolicySources(x.root, x.f.sources);
      const input = { ...x.input, modelSession: session }, result = await ensurePreparedPolicyCoverage(input);
      expect(result.activity).toBe('provider'); expect(wire).toHaveLength(2);
      const saved = await loadPolicySources(x.root, x.f.sources.id), episode = saved.coverage_episodes!.at(-1)!;
      expect(saved.coverage_episodes!.slice(0, captured.sources.coverage_episodes.length)).toEqual(captured.sources.coverage_episodes);
      expect(episode.submissions.map(submission => submission.validated)).toEqual([false, true]);
      expect(episode.submissions[1]!.tentative).toMatchObject({ status: 'unaccepted_generation' });
      const tentative: any = episode.submissions[1]!.tentative;
      expect(tentative.raw_parent).toEqual(x.f.arguments); expect(tentative.raw_response).toEqual(replies[1]);
      expect(tentative.scope).toEqual(requestScope(wire[1]));
      expect(tentative.assembled.passages).toHaveLength(34);
      expect(parse(x.f, tentative.assembled).passages).toEqual(saved.coverage!.passages);
      expect(policyReviewReadiness(x.f.source, saved.coverage, saved).ready).toBe(true);
      expect(saved.application_assignments!.every(assignment => assignment.verified === false)).toBe(true);
      expect(saved.coverage!.passages.filter(p => p.obligation_assessment).every(p => p.obligation_assessment!.verified === false)).toBe(true);
      expect(saved.coverage!.passages.some(p => p.deployment_prerequisite === 'runner_execution_setup' && p.disposition === 'needs_decision')).toBe(true);
      expect(saved.coverage!.passages.some(p => p.application_obligations?.includes('independent_source_readback') && p.disposition === 'needs_decision')).toBe(true);
      expect(JSON.stringify(wire[1])).not.toContain('opaque-private-local-continuation'); expect(JSON.stringify(events)).not.toContain('opaque-private-local-continuation');
      session.conversation.policySources = saved;
      const recheck = await ensurePreparedPolicyCoverage({ ...input, sources: saved, state: {}, force: false });
      expect(recheck.activity).toBe('validated_reuse'); expect(wire).toHaveLength(2); expect(x.input.onValidated).toHaveBeenCalledTimes(2);
      if (process.env.SYNAPSOR_TEST_EVIDENCE_DIR) await fs.writeFile(path.join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR, `latest-scoped-${provider}-composed.json`), JSON.stringify({
        classification: 'DERIVED local HTTP/SSE scoped replacement over authentic latest 31-passage parent; zero provider calls',
        parent_passages: 31, requested_parent_indices: tentative.scope.targets.flatMap((target: any) => target.members.map((member: any) => member.parent_index)),
        outside_digest: tentative.scope.outside_digest, requests: wire, replies, tentative,
        complete_findings: collectCoverageFeedback(tentative.assembled, x.f.source, x.f.draft, x.f.operator_messages),
        saved_coverage: saved.coverage, readiness: policyReviewReadiness(x.f.source, saved.coverage, saved),
      }, null, 2));
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); await fs.rm(x.root, { recursive: true, force: true }); }
  });

  it.each(['full_correction', 'transport', 'failed_reservation', 'failed_final_save', 'concurrent_source', 'drift_action', 'drift_read', 'drift_selection'])(
    '%s cannot install partial coverage or ownership', async mode => {
      const x = await prepared(f => mode === 'full_correction' ? [f.arguments, f.actual_correction] : mode === 'transport' ? [f.arguments, new Error('Local transport interrupted')] : correctedReplies(f));
      const priorCoverage = structuredClone(x.f.sources.coverage), priorOwners = structuredClone(x.f.sources.application_assignments);
      try {
        if (mode === 'failed_reservation') vi.spyOn(fs, 'rename').mockRejectedValue(new Error('Controlled reservation save failed'));
        if (mode === 'failed_final_save') x.input.operatorSession.chooseOption.mockImplementation(async () => { vi.spyOn(fs, 'rename').mockRejectedValue(new Error('Controlled final save failed')); return 'assign'; });
        if (mode === 'concurrent_source') x.input.assertCurrent = async () => { await savePolicySources(x.root, { ...x.f.sources, operator_messages: [...x.f.sources.operator_messages, 'Independent concurrent decision'] }); };
        if (mode.startsWith('drift_')) {
          const original = x.t.session.dependencies.requestJson;
          x.t.session.dependencies.requestJson = vi.fn(async (request: any) => {
            const response = await original(request);
            if (x.t.requests.length === 2) {
              if (mode === 'drift_action') x.f.draft.actions[0].effect.operation = 'changed';
              if (mode === 'drift_read') x.f.draft.read.name = 'changed';
              if (mode === 'drift_selection') x.f.draft.runner_evidence.runtime_contract.receipt_configuration.digest = canonicalJsonDigest('changed');
            }
            return response;
          });
        }
        await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow(); vi.restoreAllMocks();
        const saved = await loadPolicySources(x.root, x.f.sources.id);
        expect(saved.coverage).toEqual(priorCoverage); expect(saved.application_assignments).toEqual(priorOwners); expect(x.input.onValidated).not.toHaveBeenCalled();
        expect(x.t.requests).toHaveLength(['failed_reservation', 'concurrent_source'].includes(mode) ? 0 : 2);
        if (mode === 'failed_final_save') expect(saved.coverage_episodes!.at(-1)!.submissions.map(submission => submission.validated)).toEqual([false, true]);
        if (mode === 'concurrent_source') expect(saved.operator_messages!.at(-1)).toBe('Independent concurrent decision');
      } finally { vi.restoreAllMocks(); await fs.rm(x.root, { recursive: true, force: true }); }
    });

  it('interruption retains spent attempts; cancelled restart sends nothing and preserves the unaccepted parent', async () => {
    const x = await prepared(f => [f.arguments, new Error('Local SSE interruption')]);
    try {
      await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow('Local SSE interruption');
      const saved = await loadPolicySources(x.root, x.f.sources.id), episodes = structuredClone(saved.coverage_episodes);
      expect(episodes!.at(-1)!.submissions).toHaveLength(2); expect(episodes!.at(-1)!.submissions[0]!.validated).toBe(false);
      expect(episodes!.at(-1)!.submissions[1]!.completed_at).toBeUndefined();
      expect(saved.coverage).toEqual(captured.sources.coverage); expect(saved.application_assignments).toEqual(captured.sources.application_assignments);
      x.t.session.conversation.policySources = saved;
      x.input.operatorSession.confirm.mockClear().mockResolvedValue(false);
      await expect(ensurePreparedPolicyCoverage({ ...x.input, sources: saved, state: {} })).rejects.toThrow('POLICY_COVERAGE_EPISODE_PENDING');
      expect(x.t.requests).toHaveLength(2); expect(x.input.operatorSession.confirm).toHaveBeenCalledTimes(1); expect(x.input.onValidated).not.toHaveBeenCalled();
      expect((await loadPolicySources(x.root, x.f.sources.id)).coverage_episodes).toEqual(episodes);
    } finally { vi.restoreAllMocks(); await fs.rm(x.root, { recursive: true, force: true }); }
  });

  it('stale saved coupling fails recheck and cannot silently replenish a completed episode', async () => {
    const x = await prepared();
    try {
      await ensurePreparedPolicyCoverage(x.input);
      const saved = await loadPolicySources(x.root, x.f.sources.id), beforeEpisodes = structuredClone(saved.coverage_episodes);
      const coupling = saved.coverage!.passages.find(p => p.receipt_component === 'source_transaction_coupling')!;
      coupling.receipt_coupling!.dependencies_digest = canonicalJsonDigest('stale saved host proof');
      await savePolicySources(x.root, saved);
      expect(() => parse(x.f, { passages: saved.coverage!.passages })).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_STALE');
      x.t.session.conversation.policySources = saved; x.input.operatorSession.confirm.mockResolvedValue(false);
      await expect(ensurePreparedPolicyCoverage({ ...x.input, sources: saved, state: {}, force: false })).rejects.toThrow('POLICY_COVERAGE_EPISODE_PENDING');
      expect(x.t.requests).toHaveLength(2); expect(x.input.onValidated).toHaveBeenCalledTimes(1);
      expect((await loadPolicySources(x.root, x.f.sources.id)).coverage_episodes).toEqual(beforeEpisodes);
    } finally { vi.restoreAllMocks(); await fs.rm(x.root, { recursive: true, force: true }); }
  });
});

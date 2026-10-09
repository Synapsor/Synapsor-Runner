import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoundaryReviewInteractiveSession } from './boundary-cli-picker.js';

// UI component characterization only. Metadata owners are stubbed; no native
// authority activation, writer readiness, Source effect or recovery is proved.
const owner = vi.hoisted(() => ({ close: vi.fn(), snapshot: vi.fn(), loader: vi.fn() }));
vi.mock('./control-policy-store.js', () => ({
  openBoundProjectControlPolicies: async () => ({ project_id: 'fixture-project', deployment_id: 'fixture-deployment',
    repository: { scopeSnapshot: owner.snapshot }, close: owner.close }),
  commitImmutableControlPolicies: vi.fn(),
}));
vi.mock('./action-rule-authority.js', () => ({ createActiveActionRuleAuthorityLoader: () => owner.loader,
  listActionRuleAuthorityDrafts: vi.fn() }));
vi.mock('./saved-execution-requirements.js', () => ({ readSavedExecutionRequirements: async () => ({ source_digest: null, passages: [] }) }));
import { inspectSemanticReceiptSetup, reviewSemanticReceiptSetup } from './semantic-receipt-setup.js';
import { semanticReceiptExecutionReadback, semanticReceiptSetupReadback } from './semantic-receipt-presentation.js';
import type { SemanticReceiptSelection } from './semantic-receipt-setup.js';
import type { SemanticSupervisedExecutionPreview } from './semantic-action-deployment.js';

const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks(); owner.snapshot.mockResolvedValue({ epoch: 1, active: [] });
  owner.loader.mockResolvedValue({ registry: { rules: [{ read_boundary_name: 'fixture.read', compiled: {
    source: 'fixture_source', outcome: 'fixture.update', verification_boundary: {},
    effect_envelope: { writeback: { mode: 'direct_sql', supervised_worker: 'allowed' } },
  } }] }, authority: { catalog: { resources: [] }, action_boundary: { digest: `sha256:${'a'.repeat(64)}` } } });
});
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-ui-component-')); roots.push(root); await fs.chmod(root, 0o700);
  const configPath = path.join(root, 'synapsor.actions.runner.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: 'review', action_rules: { project_root: root },
    sources: { fixture_source: { engine: 'postgres', read_url_env: 'FIXTURE_READ' } } }));
  return { projectRoot: root, configPath, outcome: 'fixture.update', writeUrlEnv: 'FIXTURE_WRITE', env: {} };
}

it('new receipt UI states conditional production recommendation and acknowledged ledger limits without choosing or saving', async () => {
  const input = await setup(), before = await fs.readFile(input.configPath, 'utf8');
  const session = { chooseOption: vi.fn().mockResolvedValue('pause'), promptText: vi.fn(), confirm: vi.fn() } as unknown as BoundaryReviewInteractiveSession;
  expect(await reviewSemanticReceiptSetup({ ...input, session })).toBeUndefined();
  const call = vi.mocked(session.chooseOption!).mock.calls.find(([title]) => title === 'Select receipt storage for this outcome')!;
  expect(call).toBeDefined();
  const source = call[1].find(item => item.value === 'source_db')!, ledger = call[1].find(item => item.value === 'runner_ledger')!;
  expect(`${source.label} ${source.detail}`).toMatch(/recommended.*production/iu);
  expect(`${source.label} ${source.detail}`).toMatch(/verif/iu);
  expect(`${source.label} ${source.detail}`).toContain('NOT VERIFIED HERE');
  expect(`${ledger.label} ${ledger.detail}`).toMatch(/acknowledged/iu);
  expect(`${ledger.label} ${ledger.detail}`).toMatch(/unknown.*commit|commit.*unknown/iu);
  expect(call[2]).toMatchObject({ initialValue: 'runner_ledger' });
  expect(session.confirm).not.toHaveBeenCalled(); expect(session.promptText).not.toHaveBeenCalled();
  expect(await fs.readFile(input.configPath, 'utf8')).toBe(before);
  expect((await inspectSemanticReceiptSetup(input))!.selection).toBeUndefined();
});

it('configured Source receipt intent is existing and unverified, without a new-setup recommendation or changed default', async () => {
  const input = await setup();
  const config = JSON.parse(await fs.readFile(input.configPath, 'utf8'));
  config.sources.fixture_source.receipts = { authority: 'source_db', provisioning: 'precreated', schema: 'audit', table: 'receipts' };
  await fs.writeFile(input.configPath, JSON.stringify(config));
  const before = await fs.readFile(input.configPath, 'utf8');
  const inspected = (await inspectSemanticReceiptSetup(input))!;
  expect(inspected.receipt_readback.selection).toMatchObject({ origin: 'existing_configuration', mode: 'source_db', state: 'unverified' });
  expect(inspected.receipt_readback.storage).toMatchObject({ schema: 'audit', table: 'receipts', status: 'not_verified_here' });
  const session = { chooseOption: vi.fn().mockResolvedValue('pause'), promptText: vi.fn(), confirm: vi.fn() } as unknown as BoundaryReviewInteractiveSession;
  await reviewSemanticReceiptSetup({ ...input, session });
  const call = vi.mocked(session.chooseOption!).mock.calls[0]!;
  expect(call[2]).toMatchObject({ initialValue: 'runner_ledger' });
  expect(call[2]?.context?.join(' ')).toContain('Existing configured receipt intent (unverified)');
  expect(call[1].find(item => item.value === 'source_db')!.detail).not.toMatch(/recommended/iu);
  expect(session.confirm).not.toHaveBeenCalled();
  expect(await fs.readFile(input.configPath, 'utf8')).toBe(before);
});

it.each(['current', 'stale'] as const)('retains %s reviewed Source destination and writer, without altering owner data', state => {
  const selection = { receipts: { authority: 'source_db', provisioning: 'precreated', schema: 'audit', table: 'exact_receipts' },
    write_url_env: 'EXACT_WRITER' } as SemanticReceiptSelection;
  const before = JSON.stringify(selection);
  const result = semanticReceiptSetupReadback({ source_name: 'business', source: { engine: 'postgres', read_url_env: 'READ' },
    storage: undefined, selection, selection_state: state });
  expect(result.selection).toMatchObject({ origin: 'reviewed_selection', state, mode: 'source_db', write_url_env: 'EXACT_WRITER' });
  expect(result.storage).toMatchObject({ schema: 'audit', table: 'exact_receipts', status: 'not_verified_here' });
  expect(result.storage.requirements).toContain('SELECT, INSERT and UPDATE on that exact relation');
  expect(result.storage.requirements).toContain('USAGE');
  expect(result.source_db_recovery_meaning).toMatch(/original operation, scope, effect and Source identity/);
  expect(result.source_db_recovery_meaning).toMatch(/retained receipt evidence/);
  expect(result.source_db_recovery_meaning).toMatch(/authorized idempotent reconciliation/);
  expect(JSON.stringify(selection)).toBe(before);
});

it('reports ledger configured storage references and unresolved COMMIT honestly', () => {
  const result = semanticReceiptSetupReadback({ source_name: 'business', source: { engine: 'mysql', read_url_env: 'READ', receipts: { authority: 'runner_ledger' } },
    storage: { sqlite_path: './existing.db', shared_postgres: { mode: 'runtime_store', url_env: 'STORE_URL', schema: 'runner' } }, selection_state: 'stale' });
  expect(result.selection.origin).toBe('existing_configuration');
  expect(result.storage).toMatchObject({ configured_sqlite_path: './existing.db',
    configured_shared_postgres: { mode: 'runtime_store', url_env: 'STORE_URL', schema: 'runner' }, status: 'not_verified_here' });
  expect(result.runner_ledger_meaning).toMatch(/acknowledged successes/);
  expect(result.runner_ledger_meaning).toMatch(/unknown COMMIT may remain unresolved/);
  expect(result.runner_ledger_meaning).toMatch(/does not prove rollback or authorize replay/);
});

it('does not give known unsupported hard-limit MySQL a positive production recommendation', () => {
  const result = semanticReceiptSetupReadback({ source_name: 'business', source: { engine: 'mysql', read_url_env: 'READ' },
    storage: undefined, selection_state: 'stale', support_reason: 'hard_limit_engine_unsupported' });
  expect(result.support).toEqual({ status: 'not_verified_here', reason: 'hard_limit_engine_unsupported' });
  expect(result.recommendation).toContain('unsupported');
  expect(result.source_db_choice_detail).not.toMatch(/recommended/iu);
});

function executionPreview() {
  const fingerprint = `sha256:${'b'.repeat(64)}`, action = `sha256:${'a'.repeat(64)}`;
  const receipts = { authority: 'source_db', provisioning: 'precreated', schema: 'audit', table: 'receipts' };
  const policy = { outcome: 'business.update', write_url_env: 'WRITE', action_boundary_digest: action, writer_posture_fingerprint: fingerprint };
  return { source: 'business', outcome: 'business.update', write_url_env: 'WRITE', action_boundary_digest: action,
    writer_posture_fingerprint: fingerprint, receipts,
    policy,
    verification: { writer: { ok: true, fingerprint }, receipt_probe: 'passed_rolled_back' },
    config: { version: 1, supervised_worker: { outcomes: [policy] }, sources: { business: { engine: 'postgres', read_url_env: 'READ', write_url_env: 'WRITE', receipts } } },
  } as unknown as SemanticSupervisedExecutionPreview;
}

it('describes only the existing matching execution preview, without modifying it', () => {
  const preview = executionPreview(), before = JSON.stringify(preview);
  const result = semanticReceiptExecutionReadback(preview);
  expect(result.support.status).toBe('verified_by_existing_execution_preview');
  expect(result.storage).toMatchObject({ schema: 'audit', table: 'receipts', status: 'verified_by_existing_execution_preview' });
  expect(JSON.stringify(preview)).toBe(before);
});

it.each(['missing_source', 'writer_ref', 'posture', 'failed_writer', 'receipt_probe', 'receipt_destination', 'action', 'outcome', 'configured_policy'] as const)(
  'keeps execution presentation unverified after %s mismatch', mismatch => {
    const preview = executionPreview();
    if (mismatch === 'missing_source') preview.config.sources = {};
    if (mismatch === 'writer_ref') preview.write_url_env = 'OTHER';
    if (mismatch === 'posture') preview.writer_posture_fingerprint = `sha256:${'c'.repeat(64)}`;
    if (mismatch === 'failed_writer') preview.verification.writer.ok = false;
    if (mismatch === 'receipt_probe') preview.verification.receipt_probe = 'not_run_runner_ledger';
    if (mismatch === 'receipt_destination' && preview.receipts.authority === 'source_db') preview.receipts = { ...preview.receipts, table: 'other' };
    if (mismatch === 'action') preview.action_boundary_digest = `sha256:${'c'.repeat(64)}`;
    if (mismatch === 'outcome') preview.outcome = 'other.update';
    if (mismatch === 'configured_policy') preview.config.supervised_worker = { outcomes: [] };
    expect(semanticReceiptExecutionReadback(preview).support.status).toBe('not_verified_here');
  });

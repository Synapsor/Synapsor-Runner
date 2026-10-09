import { describe, expect, it } from 'vitest';
import { reviewedSharedSumFixture } from '../../../packages/action-rules/src/testing/reviewed-shared-sum-fixture.js';
import { hardLimitWriterSetupLines, inspectHardLimitWriterSetup } from './hard-limit-writer-setup.js';

describe('persisted shared limit requires every actual participating writer', () => {
  it('includes the limit writer and refuses missing writer selection', async () => {
    const f = reviewedSharedSumFixture();
    const result = await inspectHardLimitWriterSetup({ registry: f.registry,
      config: { version: 1, mode: 'review', sources: {} }, env: {} });
    expect(result.status).toBe('refused');
    expect(result.checks.map(c => c.outcome).sort()).toEqual(['shared.credit', 'shared.limit', 'shared.waiver']);
    expect(result.checks.every(c => c.reason_code === 'writer_not_selected')).toBe(true);
  });
  it('reports MySQL unsupported without suggesting a PostgreSQL grant', async () => {
    const f = reviewedSharedSumFixture();
    const result = await inspectHardLimitWriterSetup({ registry: f.registry,
      config: { version: 1, mode: 'review', sources: { [f.designation.source]: { engine: 'mysql', read_url_env: 'READ' } } }, env: {} });
    expect(result.status).toBe('refused');
    expect(result.checks.every(c => c.reason_code === 'hard_limit_engine_unsupported')).toBe(true);
    expect(result.requirements).toEqual([]);
    expect(hardLimitWriterSetupLines(result).every(line => !line.includes('GRANT'))).toBe(true);
  });
  it('refuses a reader reused as writer before opening a connection', async () => {
    const f = reviewedSharedSumFixture();
    const result = await inspectHardLimitWriterSetup({ registry: f.registry,
      config: { version: 1, mode: 'review', sources: { [f.designation.source]: {
        engine: 'postgres', read_url_env: 'READ', write_url_env: 'WRITE', read_only: false } } },
      env: { READ: 'postgres://component-unopened', WRITE: 'postgres://component-unopened' } });
    expect(result.status).toBe('refused');
    expect(result.checks.every(c => c.reason_code === 'writer_is_reader')).toBe(true);
  });
});

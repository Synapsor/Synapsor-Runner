import { ActionRuleError, type CompiledActionRuleV1 } from '@synapsor-runner/action-rules';
import type { PostgresApplyClient, PostgresActionRuleRlsScope } from './index.js';
import { assertPostgresBoundedInvariantSource } from './hard-limit-source.js';

/** Same native catalog fence, locks, effects profile and Source receipt. */
export async function assertPostgresReviewedSharedSumSource(client: PostgresApplyClient,
  compiled: CompiledActionRuleV1, scope: Pick<PostgresActionRuleRlsScope, 'tenantSetting' | 'principalSetting'> | undefined,
  receipt?: { table: string; provisioning: 'precreated' | 'auto_migrate' }): Promise<void> {
  if (compiled.target_resource.engine !== 'postgres' || compiled.hard_limit || !receipt || receipt.provisioning !== 'precreated')
    throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN',
      'The reviewed shared limit requires an inspected atomic Source receipt.', 'source.hard_limit.shared_sum_receipt');
  await assertPostgresBoundedInvariantSource(client, compiled, scope, receipt);
}

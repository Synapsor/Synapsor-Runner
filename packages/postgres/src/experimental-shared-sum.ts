import { ActionRuleError, type CompiledActionRuleV1 } from '@synapsor-runner/action-rules';
import type { PostgresApplyClient, PostgresActionRuleRlsScope } from './index.js';
import { assertPostgresBoundedInvariantSource } from './hard-limit-source.js';

/** Explicit experimental qualification inside the existing Source transaction.
 * Reuse the unchanged native profile, exact scope and precreated atomic receipt;
 * no runtime SQL, grants, migration, executor or guard service is introduced. */
export async function assertPostgresExperimentalSharedSumSource(client: PostgresApplyClient,
  compiled: CompiledActionRuleV1, scope: PostgresActionRuleRlsScope | undefined,
  receipt?: { table: string; provisioning: 'precreated' | 'auto_migrate' }): Promise<void> {
  if (compiled.target_resource.engine !== 'postgres' || compiled.hard_limit
    || !receipt || receipt.provisioning !== 'precreated') {
    throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN',
      'The experimental shared limit requires the supported atomic Source receipt.', 'experimental.shared_sum.source_receipt');
  }
  await assertPostgresBoundedInvariantSource(client, compiled, scope, receipt);
}

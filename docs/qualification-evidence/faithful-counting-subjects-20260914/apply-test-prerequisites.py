"""Run only after stable-full02 completes; product behavior is unchanged."""
from pathlib import Path
import json
E=Path(__file__).resolve().parent;repo=E.parents[2]
assert 'exit_code' in json.loads((E/'stable-full02-exit.json').read_text())
p=repo/'apps/runner/src/semantic-action-deployment.test.ts';s=p.read_text();old='''pack: { name: "reviewed_billing", resources: [{ id: "billing.preferences", tenant_key: "account_id", principal_key: "principal_id",
      rls_session: { tenant_setting: "synapsor.tenant_id" } }] }, budgets: {} };''';new='''pack: { name: "reviewed_billing", resources: [{ id: "billing.preferences", schema: "billing", table: "preferences", primary_key: "preference_id", tenant_key: "account_id", principal_key: "principal_id",
      field_types: { status: "text", version: "integer" }, field_enums: {}, selectable_fields: ["status"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["preference_id", "account_id", "principal_id", "version"], relationships: [],
      rls_session: { tenant_setting: "synapsor.tenant_id" } }] }, budgets: { max_rows: 50, max_response_cells: 500 } };''';assert old in s;s=s.replace(old,new);p.write_text(s)
p=repo/'apps/runner/src/authoring-review-continuation.test.ts';s=p.read_text();s='''import { withCountingOutcomeDomain } from "./authoring-counting-domain.js";
import { migrateProjectControlPolicies } from "./control-policy-store.js";
import { ProposalStore } from "@synapsor-runner/proposal-store";
'''+s
s=s.replace('const original = structuredClone(input), draft = policyCoverageDraft(input);','const original = structuredClone(input); let draft = policyCoverageDraft(input);')
s=s.replace('current_capability: limit.history_selector.capability, required_capability: capability','current_capability: limit.history_selector.capability, required_capability: outcome')
needle='''      const requests: string[] = [];'''
replacement='''      if (baseline.case === "assisted") {
        // The old controlled null/null reply omitted the accepted conditional
        // proof. Preserve the absent program, but supply its actual requirement
        // and establish complete domain evidence through a real owned store.
        const counter = passages[0]!;
        const conflict = parsePolicyCoverage({ passages: [{ ...counter, disposition: "conflict" }, ...passages.slice(1)] }, source, draft, session.operator_messages);
        bindPolicyCoverage(session, conflict, baseline.authority.digest);
        const config = JSON.parse(readFileSync(new URL("../../../examples/reference-support-billing-app/synapsor.runner.json", import.meta.url), "utf8"));
        config.capabilities = config.capabilities.filter((c: {kind:string}) => c.kind === "read").slice(0, 1);
        config.storage = { sqlite_path: ".synapsor/local.db" };
        await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify(config));
        new ProposalStore(path.join(root, ".synapsor/local.db")).close();
        const migrated = await migrateProjectControlPolicies({ projectRoot: root, config, storePath: path.join(root, ".synapsor/local.db"), actor: "fixture reviewer",
          readLegacySnapshot: async () => ({ revisions: [], active: [], drafts: [], provenance: [] }), validateSnapshot: async () => {} });
        await migrated.binding.close();
        const domain = await withCountingOutcomeDomain(root, baseline.authority, async value => value);
        const captured = JSON.parse(readFileSync(new URL("./fixtures/mixed-counting-review.json", import.meta.url), "utf8"));
        const support = captured.drafts[0].runner_evidence.counting_interpretations[0].operator_support;
        expect(support.answer).toBe(session.operator_messages![ownerMessage - 1]);
        draft = policyCoverageDraft({ ...input, policySources: session, operatorClarifications: [support], countingDomain: domain });
        expect(draft.runner_evidence.counting_interpretations).toHaveLength(1);
      }
      const requests: string[] = [];'''
assert needle in s;s=s.replace(needle,replacement,1)
s=s.replace('''      const coverage = await review();''','''      const coverage = await review();
      if (baseline.case === "assisted") expect(coverage.passages[0]?.counting_resolution?.kind).toBe("conditional_singleton_equivalence");''',1)
p.write_text(s)

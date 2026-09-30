import {Ajv} from 'ajv';
import { describe, expect, it } from 'vitest';
import { coverageReferences, parsePolicyCoverage, reviewPolicyCoverage } from './authoring-policy-coverage.js';
import { createModelAuthoringConversation } from './model-authoring-conversation.js';
import { authoringDestination, newPolicySourceSession, policyTextSnapshot } from './authoring-policy-source.js';
import { coverageToolDeclarationIssue } from './authoring-coverage-tool-profile.js';
import { secureAskJsonRequest } from './model-ask.js';
import { derivedScopedResponse } from './test-fixtures/coverage-derived.js';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';

// Declaration/encoder regression, not a claim of a compiled business program.
// The authentic public 50-Action failure remains in separately indexed evidence.
describe('metadata-heavy review reference declaration', () => {
  it.each([20, 50, 64].flatMap(actions => ['openai', 'openrouter'].map(provider => ({actions, provider}))))(
    'preserves the whole $actions-Action metadata profile through full and scoped $provider encodings', async ({actions, provider}) => {
      // Explicit synthetic publication profile, not a compiled/installed program
      // or a semantic interpretation of a customer policy. Real 040 is separate.
      const source = policyTextSnapshot(Buffer.from('# Whole-program metadata profile'), 'profile.txt');
      const model = provider === 'openai' ? 'fixture' : 'openai/fixture';
      const conversation = createModelAuthoringConversation();
      conversation.policySources = newPolicySourceSession();
      conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
      conversation.policySources.approvals = [{digest: source.digest,
        destination: authoringDestination({provider: provider as 'openai' | 'openrouter', model})}];
      const outcomes = Array.from({length: actions}, (_, i) => `metadata.operation_${i}`);
      const bindings = Object.fromEntries(['subject', 'private_support'].map(binding => [binding, {
        binding, resource: `metadata.${binding}`, scope: {mode: 'columns', tenant_field: 'tenant', principal_field: 'principal'},
        source: {kind: 'subject_ref'},
        fields: Object.fromEntries(Array.from({length: 16}, (_, i) => [`field_${i}`, {
          name: `field_${i}`, type: {kind: 'integer'}, nullable: false, model_visible: false,
          read_access_present: false, actual_values_returned: false, model_analysis: [],
          private_read_selection: false, private_action_verification: true,
        }])),
      }]));
      const draft = {actions: outcomes.map(outcome => ({outcome, inputs: [], require: {kind: 'all', expressions: []}})),
        runner_evidence: {actions: Object.fromEntries(outcomes.map(outcome => [outcome, {outcome,
          scoped_bindings: structuredClone(bindings), effect: {operation: 'update', observed: false}}]))}};
      const before = structuredClone(draft), beforeDigest = canonicalJsonDigest(draft);
      let requests = 0;
      const feedbacks: unknown[] = [];
      const good = {start: 1, end: 1, disposition: 'implemented', interpretation: 'Current metadata is present; no source effect or observation is established.',
        draft_paths: ['/runner_evidence/actions/metadata.operation_0']};
      const report = await reviewPolicyCoverage({source, draft,
        episode: {beforeSubmission: async () => {}, afterSubmission: async (_number, feedback) => { if (feedback) feedbacks.push(feedback); }},
        env: {OPENAI_API_KEY: 'test-key', OPENROUTER_API_KEY: 'test-key'},
        session: {provider: provider as 'openai' | 'openrouter', model, conversation, dependencies: {requestJson: async request => {
          requests++;
          const messages = (provider === 'openai' ? request.body.input : request.body.messages) as any[];
          const question = messages.filter(item => item.role === 'user').at(-1).content as string;
          const line = question.split('\n').find(value => value.startsWith('Current draft (JSON pointer root): '))!;
          const presentation = JSON.parse(line.slice(line.indexOf(': ') + 2));
          expect(presentation.encoding).toBe('scoped_binding_groups_v1');
          const expanded = structuredClone(presentation.draft);
          for (const group of presentation.scoped_binding_groups) for (const outcome of group.outcomes) {
            expect(Object.hasOwn(expanded.runner_evidence.actions[outcome], 'scoped_bindings')).toBe(false);
            expanded.runner_evidence.actions[outcome].scoped_bindings = structuredClone(group.value);
          }
          expect(expanded).toEqual(before); expect(canonicalJsonDigest(expanded)).toBe(beforeDigest);
          expect(question).toContain('Expand each exact outcome');
          expect(Buffer.byteLength(JSON.stringify(request.body))).toBeLessThan(1_048_576 - 65_536);
          expect(coverageToolDeclarationIssue(request.body, 131072)).toBeUndefined();
          await expect(secureAskJsonRequest({...request, endpoint: new Proxy(request.endpoint, {
            get() { throw new Error('OFFLINE_POST_BODY_BOUNDARY'); },
          })})).rejects.toThrow('OFFLINE_POST_BODY_BOUNDARY');
          // One malformed complete reply then one narrowly scoped replacement,
          // both actual encoders and the ordinary host assembly/parser.
          const args = requests === 1 ? {passages: [{...good, interpretation: 'x'.repeat(801)}]}
            : derivedScopedResponse(request, {passages: [good]});
          const call = {type: 'function_call', name: 'runner__review_policy_coverage',
            call_id: `metadata_${requests}`, arguments: JSON.stringify(args)};
          return provider === 'openai' ? {status: 200, body: {output: [call]}}
            : {status: 200, body: {choices: [{message: {role: 'assistant', tool_calls: [{
              id: call.call_id, type: 'function', function: {name: call.name, arguments: call.arguments},
            }]}, finish_reason: 'tool_calls'}]}};
        }}},
      });
      expect(requests).toBe(2); expect(report.passages).toHaveLength(1); expect(draft).toEqual(before);
      expect(feedbacks).toHaveLength(1);
    });

  it.each(['openai', 'openrouter'] as const)('reaches the final %s encoder within existing bounds', async provider => {
    const source = policyTextSnapshot(Buffer.from('# Metadata profile'), 'reference-profile.txt');
    const model = provider === 'openai' ? 'fixture' : 'openai/fixture';
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source];
    conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{digest: source.digest,
      destination: authoringDestination({provider, model})}];
    const draft = {actions: [], runner_evidence: {source_constraints: {resources:
      Object.fromEntries(Array.from({length: 22}, (_, resource) => [`profile.resource_${resource}`, {
        primary_key: {columns: ['id']},
        columns: Object.fromEntries(Array.from({length: 20}, (_, field) => [`field_${field}`, {
          name: `field_${field}`, type: 'integer', nullable: false, has_default: false,
          generated: false, identity: false,
        }])),
      }]))}}};
    const before = structuredClone(draft);
    let requests = 0;
    const passage = {start: 1, end: 1, disposition: 'background',
      interpretation: 'Metadata profile heading.', draft_paths: []};
    const report = await reviewPolicyCoverage({source, draft,
      env: {OPENAI_API_KEY: 'test-key', OPENROUTER_API_KEY: 'test-key'},
      session: {provider, model, conversation, dependencies: {requestJson: async request => {
        requests++;
        expect(coverageToolDeclarationIssue(request.body, 131072)).toBeUndefined();
        const tool = (request.body.tools as any[])[0];
        const parameters = provider === 'openai' ? tool.parameters : tool.function.parameters;
        const ajv = new Ajv({strict: false});
        expect(ajv.validateSchema(parameters)).toBe(true);
        const validate = ajv.compile(parameters);
        expect(validate({passages: [passage]})).toBe(true);
        const messages = (provider === 'openai' ? request.body.input : request.body.messages) as any[];
        const question = messages.filter(item => item.role === 'user').at(-1).content as string;
        const line = question.split('\n').find(value => value.startsWith('Exact coverage references (select, do not invent paths): '))!;
        const inventory = JSON.parse(line.slice(line.indexOf(': ') + 2));
        expect(inventory.encoding).toBe('pointer_prefix_groups_v1');
        const references: string[] = inventory.groups.flatMap((group: {prefix: string; suffixes: string[]}) =>
          group.suffixes.map(suffix => group.prefix + suffix));
        expect(references).toEqual(coverageReferences(draft));
        const thirtyThree = {...passage, draft_paths: references.slice(0, 33)};
        // The declaration must advertise the same existing bound as the host.
        expect(() => parsePolicyCoverage({passages: [thirtyThree]}, source, draft, [])).toThrow();
        expect(validate({passages: [thirtyThree]})).toBe(false);
        expect(question).toContain("one of THAT group's suffixes");
        expect(Buffer.byteLength(JSON.stringify(references))).toBeGreaterThan(131072);
        const validateReference = ajv.compile(parameters.properties.passages.items.properties.draft_paths.items);
        expect(references.every(reference => validateReference(reference))).toBe(true);
        expect(validateReference('/invented/reference')).toBe(false);
        expect(validateReference(references[0] + '\n')).toBe(false);
        // Exercise the ordinary final body limit without DNS/network activity.
        await expect(secureAskJsonRequest({...request, endpoint: new Proxy(request.endpoint, {
          get() { throw new Error('OFFLINE_POST_BODY_BOUNDARY'); },
        })})).rejects.toThrow('OFFLINE_POST_BODY_BOUNDARY');
        const call = {type: 'function_call', name: 'runner__review_policy_coverage',
          call_id: 'reference_profile', arguments: JSON.stringify({passages: [passage]})};
        return provider === 'openai'
          ? {status: 200, body: {id: 'reference_profile', output: [call]}}
          : {status: 200, body: {choices: [{message: {role: 'assistant', tool_calls: [{
              id: 'reference_profile', type: 'function', function: {name: call.name, arguments: call.arguments},
            }]}, finish_reason: 'tool_calls'}]}};
      }}},
    });
    expect(requests).toBe(1);
    expect(report.passages).toHaveLength(1);
    expect(draft).toEqual(before);
  });
});

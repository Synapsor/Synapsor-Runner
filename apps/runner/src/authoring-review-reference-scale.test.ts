import {Ajv} from 'ajv';
import { describe, expect, it } from 'vitest';
import { coverageReferences, reviewPolicyCoverage } from './authoring-policy-coverage.js';
import { createModelAuthoringConversation } from './model-authoring-conversation.js';
import { authoringDestination, newPolicySourceSession, policyTextSnapshot } from './authoring-policy-source.js';
import { coverageToolDeclarationIssue } from './authoring-coverage-tool-profile.js';
import { secureAskJsonRequest } from './model-ask.js';

// Declaration/encoder regression, not a claim of a compiled business program.
// The authentic public 50-Action failure remains in separately indexed evidence.
describe('metadata-heavy review reference declaration', () => {
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
        expect(ajv.compile(parameters)({passages: [passage]})).toBe(true);
        const messages = (provider === 'openai' ? request.body.input : request.body.messages) as any[];
        const question = messages.filter(item => item.role === 'user').at(-1).content as string;
        const line = question.split('\n').find(value => value.startsWith('Exact coverage references (select, do not invent paths): '))!;
        const inventory = JSON.parse(line.slice(line.indexOf(': ') + 2));
        expect(inventory.encoding).toBe('pointer_prefix_groups_v1');
        const references: string[] = inventory.groups.flatMap((group: {prefix: string; suffixes: string[]}) =>
          group.suffixes.map(suffix => group.prefix + suffix));
        expect(references).toEqual(coverageReferences(draft));
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

import {Ajv} from 'ajv';
import { describe, expect, it } from 'vitest';
import { outgoingToolSchemaIssue } from '@synapsor-runner/protocol';
import { finiteReviewDraftPresentation, finiteReviewReferenceInventory, finiteReviewReferenceSchema } from './authoring-review-reference-schema.js';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';

const large = () => Array.from({length: 2200}, (_, index) =>
  `/runner_evidence/actions/profile.operation_${Math.floor(index / 44)}/scoped_bindings/subject/fields/field_${index % 44}`);

describe('finite review reference publication', () => {
  it.each([20, 50, 64])('factors only equal complete binding values in the %i-outcome draft', count => {
    const outcomes = Array.from({length: count}, (_, i) => `operation.~0~1漢字_${i}`);
    const equal = {subject: {fields: Object.fromEntries(Array.from({length: 24}, (_, i) => [`field_${i}`, {
      field: `field_${i}`, visible: false, metadata: 'Scoped verification metadata remains distinct from a returned value or observed source effect.',
    }]))}};
    const actions = Object.fromEntries(outcomes.map((outcome, i) => [outcome, {
      outcome, scoped_bindings: i === 1 ? null : i === 2 ? {different: true} : structuredClone(equal),
      unique: i, literal_marker: {encoding: 'scoped_binding_groups_v1'},
    }]));
    delete (actions[outcomes[3]!] as any).scoped_bindings;
    const draft = {actions: outcomes.map(outcome => ({outcome})), runner_evidence: {actions}};
    // Literal metadata outside the factored location must survive untouched.
    (draft as any).literal = 'x'.repeat(140_000);
    const before = structuredClone(draft), presentation = finiteReviewDraftPresentation(draft) as any;
    expect(presentation.encoding).toBe('scoped_binding_groups_v1');
    expect(presentation.scoped_binding_groups).toHaveLength(1);
    expect(presentation.scoped_binding_groups[0].outcomes).toEqual(outcomes.filter((_, i) => ![1, 2, 3].includes(i)));
    const expanded = JSON.parse(JSON.stringify(presentation.draft));
    for (const group of presentation.scoped_binding_groups) for (const outcome of group.outcomes) {
      expect(Object.hasOwn(expanded.runner_evidence.actions[outcome], 'scoped_bindings')).toBe(false);
      expanded.runner_evidence.actions[outcome].scoped_bindings = structuredClone(group.value);
    }
    expect(expanded).toEqual(before); expect(canonicalJsonDigest(expanded)).toBe(canonicalJsonDigest(before));
    expect(draft).toEqual(before);
    expect(Object.hasOwn(presentation.draft.runner_evidence.actions[outcomes[3]!], 'scoped_bindings')).toBe(false);
    expect(presentation.draft.runner_evidence.actions[outcomes[1]!].scoped_bindings).toBeNull();
    expect(presentation.draft.runner_evidence.actions[outcomes[2]!].scoped_bindings).toEqual({different: true});
    expect(Buffer.byteLength(JSON.stringify(presentation))).toBeLessThan(Buffer.byteLength(JSON.stringify(draft)));
  });
  it('leaves small, unknown, foreign, non-beneficial and over-capacity drafts literal', () => {
    const example = (count: number) => ({literal: 'x'.repeat(140_000), actions: Array.from({length: count}, (_, i) => ({outcome: `op_${i}`})),
      runner_evidence: {actions: Object.fromEntries(Array.from({length: count}, (_, i) => [`op_${i}`, {scoped_bindings: {v: 'y'.repeat(700)}}]))}});
    const foreign = example(20); foreign.runner_evidence.actions.foreign = {scoped_bindings: {v: 'y'.repeat(700)}};
    const duplicate = example(20); duplicate.actions[1]!.outcome = duplicate.actions[0]!.outcome;
    const huge = example(20); huge.literal = 'x'.repeat(1_048_577);
    const unique = example(20);
    for (const [i, value] of Object.values(unique.runner_evidence.actions).entries()) value.scoped_bindings.v += `${i}`;
    for (const value of [undefined, null, [], {}, {actions: []}, {actions: [{outcome: 'small'}]}, foreign, duplicate, huge, unique, example(65)])
      expect(finiteReviewDraftPresentation(value)).toBe(value);
  });
  const expand = (inventory: ReturnType<typeof finiteReviewReferenceInventory>): string[] =>
    Array.isArray(inventory) ? [...inventory] :
      (inventory as {groups: {prefix: string; suffixes: string[]}[]}).groups.flatMap(group =>
        group.suffixes.map(suffix => group.prefix + suffix));
  it('keeps small, oversized and non-beneficial inventories literal', () => {
    for (const values of [[], ['/read', '/actions/0'], Array.from({length: 2200}, (_, i) => `${i}:${'x'.repeat(500)}`),
      Array.from({length: 15000}, (_, i) => `/unshared_${i}`)]) {
      expect(finiteReviewReferenceInventory(values)).toBe(values);
    }
  });
  it('preserves the exact ordered finite inventory with overlapping parents and escaped tokens', () => {
    const special = ['', '/a', '/a/b', '/a/b/c', '/a/b/c/d', '/a/b/c/😀~0~1', '/a/b/c/漢字',
      '/a/b/c/end\n', '/a/b/c/end\0', '/a/b/c/\\.*', '/a/b/c'];
    for (const values of [[...large(), ...special], [...special, ...large()].reverse()]) {
      const before = [...values], inventory = finiteReviewReferenceInventory(values);
      expect(Array.isArray(inventory)).toBe(false);
      expect(expand(inventory)).toEqual(before);
      expect(values).toEqual(before);
      expect(Buffer.byteLength(JSON.stringify(inventory))).toBeLessThan(Buffer.byteLength(JSON.stringify(values)));
      expect(expand(JSON.parse(JSON.stringify(inventory)))).toEqual(before);
    }
  });
  it('does not introduce Cartesian combinations or extra reference values', () => {
    const values = [...large(), '/another/operation/no_such_field'];
    const inventory = finiteReviewReferenceInventory(values);
    const expanded = expand(inventory);
    expect(expanded).toEqual(values);
    const validate = new Ajv({strict: false}).compile(finiteReviewReferenceSchema(values));
    expect(expanded.every(value => validate(value))).toBe(true);
    expect(validate('/another/operation/scoped_bindings/subject/fields/field_0')).toBe(false);
    expect(validate(expanded[0] + '/extra')).toBe(false);
  });
  it('preserves the existing small enum exactly', () => {
    const values = ['/read', '/actions/0', '/runner_evidence/actions/profile.operation/effect'];
    expect(finiteReviewReferenceSchema(values)).toEqual({type: 'string', enum: values});
  });
  it('represents all large-set values with a smaller valid closed consumer schema', () => {
    const values = large(), before = [...values], schema = finiteReviewReferenceSchema(values);
    const ajv = new Ajv({strict: false});
    expect(ajv.validateSchema(schema)).toBe(true);
    const validate = ajv.compile(schema);
    expect(values.every(value => validate(value))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(65536);
    expect(values).toEqual(before);
    expect(outgoingToolSchemaIssue({type:'object',additionalProperties:false,
      properties:{path:schema},required:['path']},'openai_non_strict_function',131072)).toBeUndefined();
  });
  it('refuses every altered prefix, suffix, newline and line separator', () => {
    const values = large(), validate = new Ajv({strict:false}).compile(finiteReviewReferenceSchema(values));
    for (const value of values) {
      for (const forged of [value+'\n',value+'\r',value+'\r\n',value+'\u2028',value+'\u2029',value+'\0',value+' ',
        value+'/extra', 'foreign'+value, value.slice(1), value.replaceAll('/', '／')]) {
        expect(validate(forged),forged).toBe(false);
      }
    }
    expect(validate('/runner_evidence/actions/profile.operation_0/scoped_bindings/subject/fields/unknown')).toBe(false);
  });
  it('preserves literal regex metacharacters, escaped pointer tokens and Unicode', () => {
    const special = ['', '/a', '/a/b', '/a/b/c', '/literal.*+?^${}()|[]\\', '/~0/~1', '/漢字/😀',
      '/line\nend', '/line\rend', '/tab\tend', '/null\0end', '/separator\u2028end', '/paragraph\u2029end'];
    const values = [...large(), ...special], validate = new Ajv({strict:false}).compile(finiteReviewReferenceSchema(values));
    for (const value of values) expect(validate(value),value).toBe(true);
    for (const forged of ['/literalX', '/a/b/c/d', '/漢字/😁', '/~1/~0', '/lineend', '/line\nend\n'])
      expect(validate(forged),forged).toBe(false);
  });
  it('has stable compact output for reordered values and duplicates', () => {
    const values = large();
    expect(finiteReviewReferenceSchema([...values].reverse())).toEqual(finiteReviewReferenceSchema(values));
    expect(finiteReviewReferenceSchema([...values,values[0]!])).toEqual(finiteReviewReferenceSchema(values));
  });
  it('does not construct an unbounded tree or publish an invalid empty enum', () => {
    expect(() => finiteReviewReferenceSchema([])).toThrow('nonempty set');
    const values = Array.from({length: 2200}, (_, index) => `${index}:${'x'.repeat(500)}`);
    expect(finiteReviewReferenceSchema(values)).toEqual({type:'string',enum:values});
    expect(outgoingToolSchemaIssue({type:'object',additionalProperties:false,
      properties:{path:finiteReviewReferenceSchema(values)},required:['path']},'openai_non_strict_function',131072)?.code)
      .toBe('schema_exceeds_limit');
  });
});

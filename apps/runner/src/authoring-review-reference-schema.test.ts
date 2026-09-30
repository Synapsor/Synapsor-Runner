import {Ajv} from 'ajv';
import { describe, expect, it } from 'vitest';
import { outgoingToolSchemaIssue } from '@synapsor-runner/protocol';
import { finiteReviewReferenceInventory, finiteReviewReferenceSchema } from './authoring-review-reference-schema.js';

const large = () => Array.from({length: 2200}, (_, index) =>
  `/runner_evidence/actions/profile.operation_${Math.floor(index / 44)}/scoped_bindings/subject/fields/field_${index % 44}`);

describe('finite review reference publication', () => {
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

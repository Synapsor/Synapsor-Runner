import {Ajv} from 'ajv';
import { describe, expect, it } from 'vitest';
import { outgoingToolSchemaIssue } from '@synapsor-runner/protocol';
import { finiteReviewReferenceSchema } from './authoring-review-reference-schema.js';

const large = () => Array.from({length: 2200}, (_, index) =>
  `/runner_evidence/actions/profile.operation_${Math.floor(index / 44)}/scoped_bindings/subject/fields/field_${index % 44}`);

describe('finite review reference publication', () => {
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

import { describe, it, expect } from 'vitest';
import { formatConstraints, enrichParamsTable } from '../src/renderer/constraints.js';

describe('formatConstraints', () => {
  it('formats numeric range with default (limit case)', () => {
    expect(formatConstraints({ type: 'integer', minimum: 1, maximum: 100, default: 20 })).toBe(
      '1–100，默认 20',
    );
  });

  it('formats minimum only / maximum only', () => {
    expect(formatConstraints({ type: 'integer', minimum: 1 })).toBe('≥ 1');
    expect(formatConstraints({ type: 'integer', maximum: 100 })).toBe('≤ 100');
  });

  it('formats exclusive bounds', () => {
    expect(formatConstraints({ type: 'number', exclusiveMinimum: 0 })).toBe('> 0');
    expect(formatConstraints({ type: 'number', exclusiveMaximum: 1 })).toBe('< 1');
  });

  it('formats string length', () => {
    expect(formatConstraints({ type: 'string', minLength: 2, maxLength: 8 })).toBe('长度 2–8');
    expect(formatConstraints({ type: 'string', minLength: 1 })).toBe('长度 ≥ 1');
  });

  it('formats array length', () => {
    expect(formatConstraints({ type: 'array', minItems: 1, maxItems: 5 })).toBe('元素 1–5');
  });

  it('formats pattern', () => {
    expect(formatConstraints({ type: 'string', pattern: '^[a-z]+$' })).toBe('匹配 `^[a-z]+$`');
  });

  it('formats short enum but not long enum', () => {
    expect(formatConstraints({ enum: ['a', 'b'] })).toBe('枚举 a/b');
    expect(formatConstraints({ enum: ['a', 'b', 'c', 'd', 'e'] })).toBe('');
  });

  it('includes meaningful format but skips int/float noise', () => {
    expect(formatConstraints({ type: 'string', format: 'email' })).toBe('email');
    expect(formatConstraints({ type: 'integer', format: 'int64' })).toBe('');
  });

  it('combines length + default', () => {
    expect(formatConstraints({ type: 'string', maxLength: 32, default: 'x' })).toBe(
      '长度 ≤ 32，默认 x',
    );
  });

  it('returns empty for constraint-free schema', () => {
    expect(formatConstraints({ type: 'string' })).toBe('');
    expect(formatConstraints(undefined)).toBe('');
  });
});

describe('enrichParamsTable', () => {
  const api = {
    paths: {
      '/x': {
        get: {
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            { name: 'roomNo', in: 'path', schema: { type: 'string' } },
          ],
        },
      },
    },
  };

  it('inserts a 约束 column and fills it by param name', () => {
    const md = `<h3>参数</h3>

| 名称 | 位置 | 类型 | 必填 | 描述 |
|---|---|---|---|---|
|roomNo|path|string|true|房间号|
|limit|query|integer|false|每页条数|`;
    const out = enrichParamsTable(md, api);
    expect(out).toContain('| 名称 | 位置 | 类型 | 必填 | 约束 | 描述 |');
    // limit row gets the constraint, roomNo row gets an empty 约束 cell
    expect(out).toMatch(/\|limit\|query\|integer\|false\| 1–100，默认 20 \|每页条数\|/);
    expect(out).toMatch(/\|roomNo\|path\|string\|true\| \|房间号\|/);
  });

  it('handles » prefixed names (strips arrows before lookup)', () => {
    const md = `| 名称 | 位置 | 类型 | 必填 | 描述 |
|---|---|---|---|---|
|» limit|query|integer|false|每页条数|`;
    const out = enrichParamsTable(md, api);
    expect(out).toMatch(/\|» limit\|query\|integer\|false\| 1–100，默认 20 \|每页条数\|/);
  });

  it('no-op when no params have constraints', () => {
    const noConstraintApi = {
      paths: { '/x': { get: { parameters: [{ name: 'a', in: 'query', schema: { type: 'string' } }] } } },
    };
    const md = `| 名称 | 位置 | 类型 | 必填 | 描述 |
|---|---|---|---|---|
|a|query|string|false|x|`;
    expect(enrichParamsTable(md, noConstraintApi)).toBe(md);
  });

  it('does not double-insert when a 约束 column already exists', () => {
    const md = `| 名称 | 位置 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|---|
|limit|query|integer|false| |每页条数|`;
    const out = enrichParamsTable(md, api);
    // header should still have exactly one 约束
    expect((out.match(/约束/g) ?? []).length).toBe(1);
  });
});

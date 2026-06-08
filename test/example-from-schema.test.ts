import { describe, it, expect } from 'vitest';
import {
  generateExample,
  exampleForOperation,
  requestBodyExampleForOperation,
} from '../src/renderer/example-from-schema.js';

describe('generateExample', () => {
  it('uses schema.example when present', () => {
    expect(generateExample({ type: 'string', example: 'hello' })).toBe('hello');
  });

  it('uses first enum value when no example', () => {
    expect(generateExample({ type: 'string', enum: ['a', 'b'] })).toBe('a');
  });

  it('boolean defaults to true (for 2xx success)', () => {
    expect(generateExample({ type: 'boolean' })).toBe(true);
  });

  it('string defaults to "string"', () => {
    expect(generateExample({ type: 'string' })).toBe('string');
  });

  it('integer/number default to 0', () => {
    expect(generateExample({ type: 'integer' })).toBe(0);
    expect(generateExample({ type: 'number' })).toBe(0);
  });

  it('honors format hints', () => {
    expect(generateExample({ type: 'string', format: 'date-time' })).toBe('2026-01-01T00:00:00Z');
    expect(generateExample({ type: 'string', format: 'uuid' })).toMatch(/^[0-9a-f-]+$/);
    expect(generateExample({ type: 'string', format: 'email' })).toContain('@');
  });

  it('builds nested object from properties', () => {
    const ex = generateExample({
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'tag_123' },
            count: { type: 'integer', example: 42 },
          },
        },
      },
    });
    expect(ex).toEqual({
      success: true,
      data: { id: 'tag_123', count: 42 },
    });
  });

  it('arrays generate single sample item', () => {
    const ex = generateExample({
      type: 'array',
      items: { type: 'string', example: 'tag1' },
    });
    expect(ex).toEqual(['tag1']);
  });

  it('handles oneOf by picking first', () => {
    const ex = generateExample({
      oneOf: [
        { type: 'string', example: 'first' },
        { type: 'integer', example: 99 },
      ],
    });
    expect(ex).toBe('first');
  });

  it('cycle-safe', () => {
    const a: any = { type: 'object', properties: {} };
    a.properties.self = a;
    const ex = generateExample(a);
    expect(ex).toEqual({ self: null });
  });
});

describe('exampleForOperation', () => {
  it('picks 200 over default', () => {
    const op = {
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } },
            },
          },
        },
        default: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { error: { type: 'string', example: 'err' } } },
            },
          },
        },
      },
    };
    const r = exampleForOperation(op);
    expect(r?.status).toBe('200');
    expect(r?.example).toEqual({ ok: true });
  });

  it('falls back to default when 2xx missing', () => {
    const op = {
      responses: {
        default: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { x: { type: 'integer' } } },
            },
          },
        },
      },
    };
    const r = exampleForOperation(op);
    expect(r?.status).toBe('default');
    expect(r?.example).toEqual({ x: 0 });
  });

  it('returns null when no JSON content', () => {
    const op = {
      responses: { '200': { description: 'no body' } },
    };
    expect(exampleForOperation(op)).toBeNull();
  });
});

describe('requestBodyExampleForOperation (v0.7)', () => {
  it('synthesizes a JSON example from the requestBody schema', () => {
    const op = {
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                familyId: { type: 'string', example: 'family_001' },
                status: { type: 'string', enum: ['normal', 'all'] },
                page: { type: 'integer', default: 1 },
              },
            },
          },
        },
      },
    };
    const r = requestBodyExampleForOperation(op);
    expect(r?.example).toEqual({ familyId: 'family_001', status: 'normal', page: 1 });
  });

  it('returns null for a GET / no-requestBody operation', () => {
    expect(requestBodyExampleForOperation({ responses: {} })).toBeNull();
    expect(requestBodyExampleForOperation({ requestBody: { content: {} } })).toBeNull();
  });
});

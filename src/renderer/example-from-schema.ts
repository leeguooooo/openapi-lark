/**
 * Generate a sample JSON value from a (dereferenced + allOf-flattened) JSON
 * Schema. Used to inject "响应示例" blocks into endpoint docs.
 *
 * Preference order for each field:
 *   1. schema.example
 *   2. schema.examples[0]
 *   3. First enum value
 *   4. Type-based default (with format hints: date / date-time / uuid / email)
 *
 * Safety:
 *   - Cycle-safe via WeakSet
 *   - Object recursion capped (skip empty props gracefully)
 */

function isObj(x: unknown): x is Record<string, any> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

const FORMAT_DEFAULTS: Record<string, () => unknown> = {
  'date-time': () => '2026-01-01T00:00:00Z',
  date: () => '2026-01-01',
  uuid: () => '00000000-0000-0000-0000-000000000000',
  email: () => 'user@example.com',
  uri: () => 'https://example.com',
  url: () => 'https://example.com',
  int64: () => 0,
  int32: () => 0,
  float: () => 0,
  double: () => 0,
};

export function generateExample(schema: any, seen: WeakSet<object> = new WeakSet()): unknown {
  if (!isObj(schema)) return null;
  if (seen.has(schema)) return null;
  seen.add(schema);

  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const type = schema.type;
  const fmt: string | undefined = typeof schema.format === 'string' ? schema.format : undefined;

  if (type === 'string' || (!type && schema.properties === undefined && fmt)) {
    if (fmt && FORMAT_DEFAULTS[fmt]) return FORMAT_DEFAULTS[fmt]();
    return 'string';
  }
  if (type === 'integer' || type === 'number') {
    if (fmt && FORMAT_DEFAULTS[fmt]) return FORMAT_DEFAULTS[fmt]();
    return 0;
  }
  // Boolean default = true: in 2xx success responses, `success: true` is the
  // expected value, and most "isXxx" flags read more naturally as true in docs.
  if (type === 'boolean') return true;
  if (type === 'array') {
    if (isObj(schema.items)) return [generateExample(schema.items, seen)];
    return [];
  }
  if (type === 'object' || isObj(schema.properties)) {
    const out: Record<string, unknown> = {};
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const [k, sub] of Object.entries(props)) {
      out[k] = generateExample(sub, seen);
    }
    return out;
  }
  // oneOf / anyOf — pick first
  for (const k of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[k]) && schema[k].length > 0) {
      return generateExample(schema[k][0], seen);
    }
  }
  return null;
}

/**
 * Pick the "primary" 2xx response from an operation and synthesize its JSON
 * example. Returns null when no usable schema exists.
 */
export function exampleForOperation(op: any): { status: string; example: unknown } | null {
  if (!isObj(op?.responses)) return null;
  // Prefer 200, then any 2xx, then default
  const order: string[] = ['200', '201', '202', '204', 'default'];
  const all = Object.keys(op.responses);
  for (const k of all) {
    if (!order.includes(k) && /^2\d\d$/.test(k)) order.splice(order.length - 1, 0, k);
  }
  for (const status of order) {
    const r = op.responses[status];
    const schema = r?.content?.['application/json']?.schema;
    if (isObj(schema)) {
      const ex = generateExample(schema);
      if (ex !== null && ex !== undefined) return { status, example: ex };
    }
  }
  return null;
}

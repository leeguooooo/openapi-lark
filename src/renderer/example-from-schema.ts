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
  // `default` is a meaningful concrete value (esp. for request bodies) — prefer
  // it over a generic type default. Skip for objects/arrays (let recursion build
  // a representative shape rather than echoing a possibly-empty default).
  if (
    schema.default !== undefined &&
    schema.type !== 'object' &&
    schema.type !== 'array' &&
    schema.properties === undefined
  ) {
    return schema.default;
  }

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

/**
 * Synthesize a JSON example for an operation's requestBody (application/json).
 * Returns null for GET/DELETE / operations without a JSON requestBody schema.
 * Mirrors exampleForOperation but for the request side.
 */
export function requestBodyExampleForOperation(op: any): { example: unknown } | null {
  const content = op?.requestBody?.content?.['application/json'];
  // 作者在 content 上给了真实示例（example / examples）就用它，不再从 schema 合成
  const authored = authoredExamples(content);
  if (authored.length) return { example: authored[0].value };
  const schema = content?.schema;
  if (!isObj(schema)) return null;
  const ex = generateExample(schema);
  if (ex === null || ex === undefined) return null;
  return { example: ex };
}

export interface NamedExample {
  status: string;
  /** examples 映射里的键；单个 example / 合成示例时为空串 */
  name: string;
  /** examples[].summary，没有则空串 */
  summary: string;
  value: unknown;
}

/**
 * content 上作者手写的示例：OpenAPI 的 `examples`（具名、可多个）优先，其次单个 `example`。
 * `externalValue` 只有链接没有内容，跳过。
 */
function authoredExamples(content: any): Array<Omit<NamedExample, 'status'>> {
  if (!isObj(content)) return [];
  const out: Array<Omit<NamedExample, 'status'>> = [];
  if (isObj(content.examples)) {
    for (const [name, ex] of Object.entries(content.examples as Record<string, any>)) {
      if (!isObj(ex) || !('value' in ex)) continue;
      out.push({ name, summary: typeof ex.summary === 'string' ? ex.summary : '', value: ex.value });
    }
  }
  if (!out.length && content.example !== undefined) out.push({ name: '', summary: '', value: content.example });
  return out;
}

/**
 * 响应示例（v0.14）：作者写了具名 examples 就全部返回（一个 drop.type 一条这种），
 * 否则退回 exampleForOperation 的合成示例（单条、无名）。状态码挑法与 exampleForOperation 一致。
 */
export function namedExamplesForOperation(op: any): NamedExample[] {
  if (!isObj(op?.responses)) return [];
  const order: string[] = ['200', '201', '202', '204', 'default'];
  for (const k of Object.keys(op.responses)) {
    if (!order.includes(k) && /^2\d\d$/.test(k)) order.splice(order.length - 1, 0, k);
  }
  for (const status of order) {
    const content = op.responses[status]?.content?.['application/json'];
    const authored = authoredExamples(content);
    if (authored.length) return authored.map((a) => ({ status, ...a }));
  }
  const synthesized = exampleForOperation(op);
  return synthesized ? [{ status: synthesized.status, name: '', summary: '', value: synthesized.example }] : [];
}

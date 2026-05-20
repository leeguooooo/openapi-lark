/**
 * Recursively flatten `allOf` composition into a single object schema.
 *
 * Why: widdershins does not deep-expand `allOf` — it shows "Inline" in the
 * response table and renders nothing for the schema body. Voice-room (and most
 * OpenAPI specs using the `BaseResponse + payload` pattern) has every 2xx
 * response wrapped like:
 *
 *   schema:
 *     allOf:
 *       - $ref: '#/components/schemas/BaseResponse'    # success/errCode/...
 *       - type: object                                   # data: <payload>
 *         properties:
 *           data: { $ref: '#/components/schemas/X' }
 *
 * After this transform: the schema becomes a single object whose properties
 * merge BaseResponse's + the extra `data` field, and widdershins renders the
 * full field table.
 *
 * Assumes swagger-parser has already dereferenced refs; allOf members are
 * concrete schemas.
 */

function isPlainObject(x: unknown): x is Record<string, any> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

export function flattenAllOf(schema: any, seen = new WeakSet<object>()): any {
  if (!isPlainObject(schema)) return schema;
  if (seen.has(schema)) return schema; // cycle guard
  seen.add(schema);

  // Process child schemas first
  for (const k of ['properties', 'patternProperties']) {
    if (isPlainObject(schema[k])) {
      const out: Record<string, any> = {};
      for (const [name, sub] of Object.entries(schema[k])) {
        out[name] = flattenAllOf(sub, seen);
      }
      schema[k] = out;
    }
  }
  if (isPlainObject(schema.items)) {
    schema.items = flattenAllOf(schema.items, seen);
  } else if (Array.isArray(schema.items)) {
    schema.items = schema.items.map((s: any) => flattenAllOf(s, seen));
  }
  if (isPlainObject(schema.additionalProperties)) {
    schema.additionalProperties = flattenAllOf(schema.additionalProperties, seen);
  }

  // Now flatten allOf at this level
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, any> = {};
    const props: Record<string, any> = {};
    const required = new Set<string>();
    const descriptions: string[] = [];
    let type: string | undefined = undefined;

    // Preserve own fields outside allOf (e.g. an allOf next to its own properties)
    if (typeof schema.type === 'string') type = schema.type;
    if (typeof schema.description === 'string' && schema.description.trim()) {
      descriptions.push(schema.description.trim());
    }
    if (isPlainObject(schema.properties)) {
      for (const [k, v] of Object.entries(schema.properties)) props[k] = v;
    }
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) required.add(String(r));
    }

    for (const member of schema.allOf) {
      const m = flattenAllOf(member, seen);
      if (!isPlainObject(m)) continue;
      if (!type && typeof m.type === 'string') type = m.type;
      if (typeof m.description === 'string' && m.description.trim()) {
        descriptions.push(m.description.trim());
      }
      if (isPlainObject(m.properties)) {
        for (const [k, v] of Object.entries(m.properties)) {
          // Last write wins (later allOf members override earlier on same key)
          props[k] = v;
        }
      }
      if (Array.isArray(m.required)) {
        for (const r of m.required) required.add(String(r));
      }
      // Carry through other relevant fields when first encountered
      for (const k of ['example', 'examples', 'enum', 'format', 'pattern', 'additionalProperties']) {
        if (merged[k] === undefined && m[k] !== undefined) merged[k] = m[k];
      }
    }

    // Build the flattened result; drop allOf
    const out: Record<string, any> = { ...schema, ...merged };
    delete out.allOf;
    if (type ?? '') out.type = type ?? 'object';
    else if (!out.type) out.type = 'object';
    out.properties = props;
    if (required.size > 0) out.required = [...required];
    if (descriptions.length > 0 && !out.description) out.description = descriptions.join(' | ');
    return out;
  }

  return schema;
}

/**
 * Walk every response/requestBody/parameter schema in an api and apply
 * flattenAllOf in place. Returns the same api object (mutated).
 */
export function flattenAllOfInApi(api: any): any {
  const paths = api?.paths;
  if (!isPlainObject(paths)) return api;

  const HTTP = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  for (const pathItem of Object.values(paths)) {
    if (!isPlainObject(pathItem)) continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP.has(method.toLowerCase())) continue;
      if (!isPlainObject(op)) continue;
      // parameters
      if (Array.isArray(op.parameters)) {
        for (const p of op.parameters) {
          if (isPlainObject(p?.schema)) p.schema = flattenAllOf(p.schema);
        }
      }
      // requestBody
      const content = op.requestBody?.content;
      if (isPlainObject(content)) {
        for (const ct of Object.values(content)) {
          if (isPlainObject(ct) && isPlainObject((ct as any).schema)) {
            (ct as any).schema = flattenAllOf((ct as any).schema);
          }
        }
      }
      // responses
      const responses = op.responses;
      if (isPlainObject(responses)) {
        for (const r of Object.values(responses)) {
          const rc = (r as any)?.content;
          if (isPlainObject(rc)) {
            for (const ct of Object.values(rc)) {
              if (isPlainObject(ct) && isPlainObject((ct as any).schema)) {
                (ct as any).schema = flattenAllOf((ct as any).schema);
              }
            }
          }
        }
      }
    }
  }
  return api;
}

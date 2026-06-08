/**
 * Format JSON-Schema validation keywords into a short, human-readable Chinese
 * 约束 (constraints) string, and enrich widdershins-rendered tables with them.
 *
 * Why: widdershins drops most validation keywords (minimum/maximum/default/
 * pattern/…) — the 约束 column it emits is almost always empty even when the
 * schema carries them. We re-derive the constraint text from the parsed +
 * dereferenced OpenAPI (the same object the renderer already has) and splice it
 * back into the parameters table and the response-schema tables.
 */

function isObj(x: unknown): x is Record<string, any> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function shortJson(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Build the constraint text for a single JSON-Schema. Returns '' when the schema
 * has no constraint-bearing keywords. The schema is assumed dereferenced and
 * allOf-flattened.
 */
export function formatConstraints(schema: any): string {
  if (!isObj(schema)) return '';
  const parts: string[] = [];

  // Numeric range — collapse min/max into a single `a–b` token when both exist.
  const hasMin = typeof schema.minimum === 'number';
  const hasMax = typeof schema.maximum === 'number';
  const exMin = typeof schema.exclusiveMinimum === 'number';
  const exMax = typeof schema.exclusiveMaximum === 'number';
  if (hasMin && hasMax) {
    parts.push(`${schema.minimum}–${schema.maximum}`);
  } else if (hasMin) {
    parts.push(`≥ ${schema.minimum}`);
  } else if (hasMax) {
    parts.push(`≤ ${schema.maximum}`);
  }
  // exclusiveMinimum/Maximum as numbers (OpenAPI 3.1 / JSON-Schema draft 2020-12)
  if (exMin) parts.push(`> ${schema.exclusiveMinimum}`);
  if (exMax) parts.push(`< ${schema.exclusiveMaximum}`);
  // boolean exclusiveMinimum/Maximum (OpenAPI 3.0) qualifies an existing min/max,
  // already covered by the range token above; nothing extra to add.

  // String length
  const hasMinLen = typeof schema.minLength === 'number';
  const hasMaxLen = typeof schema.maxLength === 'number';
  if (hasMinLen && hasMaxLen) {
    parts.push(`长度 ${schema.minLength}–${schema.maxLength}`);
  } else if (hasMinLen) {
    parts.push(`长度 ≥ ${schema.minLength}`);
  } else if (hasMaxLen) {
    parts.push(`长度 ≤ ${schema.maxLength}`);
  }

  // Array length
  const hasMinItems = typeof schema.minItems === 'number';
  const hasMaxItems = typeof schema.maxItems === 'number';
  if (hasMinItems && hasMaxItems) {
    parts.push(`元素 ${schema.minItems}–${schema.maxItems}`);
  } else if (hasMinItems) {
    parts.push(`元素 ≥ ${schema.minItems}`);
  } else if (hasMaxItems) {
    parts.push(`元素 ≤ ${schema.maxItems}`);
  }

  // format (only when meaningful — skip the int32/int64 noise widdershins already
  // shows inline in the 类型 column)
  if (typeof schema.format === 'string' && schema.format.trim()) {
    const fmt = schema.format.trim();
    if (!['int32', 'int64', 'float', 'double'].includes(fmt)) {
      parts.push(fmt);
    }
  }

  // pattern
  if (typeof schema.pattern === 'string' && schema.pattern.trim()) {
    parts.push(`匹配 \`${schema.pattern.trim()}\``);
  }

  // enum (short form — only when small; long enums get their own table)
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 4) {
    parts.push(`枚举 ${schema.enum.map(shortJson).join('/')}`);
  }

  // default — always last
  if (schema.default !== undefined) {
    parts.push(`默认 ${shortJson(schema.default)}`);
  }

  return parts.join('，');
}

/**
 * Locate constraint-bearing schemas for every parameter of the operations in an
 * api, keyed by parameter name. Used to enrich the parameters table.
 */
function collectParamConstraints(api: any): Map<string, string> {
  const out = new Map<string, string>();
  const paths = isObj(api?.paths) ? api.paths : {};
  const HTTP = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  for (const pathItem of Object.values(paths)) {
    if (!isObj(pathItem)) continue;
    const sharedParams = Array.isArray((pathItem as any).parameters)
      ? (pathItem as any).parameters
      : [];
    for (const [method, op] of Object.entries(pathItem as Record<string, any>)) {
      if (!HTTP.has(method.toLowerCase())) continue;
      if (!isObj(op)) continue;
      const params = [
        ...sharedParams,
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      for (const p of params) {
        if (!isObj(p) || typeof p.name !== 'string') continue;
        const c = formatConstraints(p.schema);
        if (c) out.set(p.name, c);
      }
    }
  }
  return out;
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const inner = trimmed.slice(1, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '|' && (i === 0 || inner[i - 1] !== '\\')) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function isSeparator(cells: string[]): boolean {
  return cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

/**
 * Enrich the parameters table's 约束 column from the parsed schema.
 *
 * widdershins emits the parameters table as:
 *   | 名称 | 位置 | 类型 | 必填 | 描述 |
 * (no 约束 column). We detect that exact header and INSERT a 约束 column before
 * 描述, populated per-row by parameter name. Rows whose param has no constraints
 * get an empty cell.
 *
 * Runs on the already-localized markdown (headers are Chinese by this point).
 */
export function enrichParamsTable(md: string, api: any): string {
  const constraints = collectParamConstraints(api);
  if (constraints.size === 0) return md;

  const lines = md.split('\n');
  const out: string[] = [];
  let inParamTable = false;
  let nameColIdx = -1;
  let descColIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cells = splitRow(line);
    if (!cells) {
      inParamTable = false;
      out.push(line);
      continue;
    }
    const trimmedCells = cells.map((c) => c.trim());

    // Header detection: localized params header WITHOUT a 约束 column.
    const isParamsHeader =
      trimmedCells.includes('名称') &&
      trimmedCells.includes('位置') &&
      trimmedCells.includes('类型') &&
      trimmedCells.includes('必填') &&
      trimmedCells.includes('描述') &&
      !trimmedCells.includes('约束');

    if (isParamsHeader) {
      inParamTable = true;
      nameColIdx = trimmedCells.indexOf('名称');
      descColIdx = trimmedCells.indexOf('描述');
      const inserted = [...cells];
      inserted.splice(descColIdx, 0, ' 约束 ');
      out.push('|' + inserted.join('|') + '|');
      continue;
    }

    if (inParamTable) {
      if (isSeparator(trimmedCells)) {
        const inserted = [...cells];
        inserted.splice(descColIdx, 0, '---');
        out.push('|' + inserted.join('|') + '|');
        continue;
      }
      // body row: look up by name cell
      const name = trimmedCells[nameColIdx]?.replace(/^»+\s*/, '').trim();
      const c = name ? (constraints.get(name) ?? '') : '';
      const inserted = [...cells];
      inserted.splice(descColIdx, 0, c ? ` ${c} ` : ' ');
      out.push('|' + inserted.join('|') + '|');
      continue;
    }

    out.push(line);
  }
  return out.join('\n');
}

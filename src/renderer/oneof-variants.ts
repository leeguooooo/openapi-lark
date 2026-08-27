/**
 * oneOf / anyOf 字段按变体分表（v0.13）。
 *
 * widdershins 遇到 `body: { oneOf: [A, B] }` 这种「形状由别的字段决定」的字段时，
 * 是分了表的，但输出长这样：
 *
 *   |»»» body|any|true| |块内容，形状由 key 决定|
 *
 *   *oneOf*
 *
 *   | 名称 | 类型 | 必填 | 约束 | 描述 |
 *   |»»»» *anonymous*|object|false| |key=common 时：公开参数|
 *   |»»»»» shield_max|integer|true| |盾牌上限|
 *
 *   *xor*
 *
 *   | 名称 | ... |
 *   |»»»» *anonymous*|object|false| |key=board 时：盘面|
 *   |»»»»» cells|[object]|true| |启用的盘面格|
 *
 * 三处让人读不下去：`*oneOf*` / `*xor*` 是 JSON Schema 术语，读者不知道在说
 * 「四选一」；每张表开头一行 `*anonymous*` 是 schema 没名字的副作用；转飞书时点路径
 * 按表重算，变体表里的行拼不出 `data.chunks[].body.shield_max` 这种完整路径
 * （祖先在上一张表里）。实际项目里（aeroplane 资源块接口）就因为这个把 oneOf 撤了，
 * 改成 `unknown` + 一句「见 wiki」，字段说明整个没了。
 *
 * 这里改成：
 *
 *   **data.chunks[].body 形状 1/2：key=common 时：公开参数**
 *
 *   | 名称 | 类型 | 必填 | 约束 | 描述 |
 *   |data.chunks[].body.shield_max|integer|true| |盾牌上限|
 *
 * 变体表的第一列直接写完整点路径（祖先从上一张主表推出来），不再带 `»` 标记；
 * 下游 dottifySchemaRows 看到没有标记就原样放行，两种模式（markdown / 飞书 XML）
 * 输出一致。主表里那一行的类型若变体全是 object，则由 `any` 改成 `object`。
 *
 * 只处理 oneOf / anyOf。allOf 在 flatten-allof 里已经摊平，到不了这里。
 */

const MARKER_RE = /^\*(oneOf|anyOf|xor|or)\*$/;

interface SchemaRow {
  depth: number;
  name: string;
  cells: string[];
}

function splitCells(line: string): string[] | null {
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
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function parseMarkerCell(cell: string): { depth: number; name: string } | null {
  const m = cell.trim().match(/^(»+)\s*(.*)$/);
  if (!m) return null;
  return { depth: m[1].length - 1, name: m[2].trim() };
}

function isArrayType(typeCell: string): boolean {
  return /^\[.*\]$/.test(typeCell.trim());
}

/** 一张已经切好行的表：表头、分隔行、正文 */
interface Table {
  start: number; // 表头所在行号
  end: number; // 最后一行（含）
  header: string[];
  rows: string[][];
}

function readTable(lines: string[], from: number): Table | null {
  let i = from;
  while (i < lines.length && lines[i].trim() === '') i++;
  const header = i < lines.length ? splitCells(lines[i]) : null;
  if (!header) return null;
  const sep = i + 1 < lines.length ? splitCells(lines[i + 1]) : null;
  if (!sep || !isSeparator(sep)) return null;
  const rows: string[][] = [];
  let j = i + 2;
  for (; j < lines.length; j++) {
    const cells = splitCells(lines[j]);
    if (!cells) break;
    rows.push(cells);
  }
  return { start: i, end: j - 1, header, rows };
}

function columnIndex(header: string[], name: string): number {
  return header.findIndex((c) => c.trim() === name);
}

/**
 * 主表里最后一行带 `»` 标记的字段——就是 oneOf 挂在哪个字段上。
 * 顺便把它的祖先段（含数组 `[]`）算出来，变体表拼路径要用。
 */
function lastSchemaRow(
  table: Table,
): { row: SchemaRow; segments: string[]; rowIdx: number } | null {
  const nameIdx = columnIndex(table.header, '名称');
  const typeIdx = columnIndex(table.header, '类型');
  if (nameIdx !== 0 || typeIdx < 0) return null;
  const ancestors: string[] = [];
  let found: { row: SchemaRow; segments: string[]; rowIdx: number } | null = null;
  table.rows.forEach((cells, idx) => {
    const parsed = parseMarkerCell(cells[nameIdx] ?? '');
    if (!parsed) return;
    const segment = isArrayType(cells[typeIdx] ?? '') ? `${parsed.name}[]` : parsed.name;
    ancestors[parsed.depth] = segment;
    ancestors.length = parsed.depth + 1;
    found = { row: { ...parsed, cells }, segments: ancestors.slice(), rowIdx: idx };
  });
  return found;
}

interface Variant {
  label: string;
  headType: string;
  table: Table;
}

/**
 * 把一组连续的 `*oneOf*` 表 + `*xor*` 表（或 anyOf/or）读出来。
 * 返回 null 表示这里不是我们认识的形状，原样保留。
 */
function readVariantGroup(lines: string[], markerLine: number): { variants: Variant[]; end: number } | null {
  const variants: Variant[] = [];
  let i = markerLine;
  while (i < lines.length) {
    const m = lines[i].trim().match(MARKER_RE);
    if (!m) break;
    const kind = m[1];
    // 组内第二张起只认续接标记；换成另一组 oneOf 就停
    if (variants.length > 0 && (kind === 'oneOf' || kind === 'anyOf')) break;
    const table = readTable(lines, i + 1);
    if (!table) return null;
    const nameIdx = columnIndex(table.header, '名称');
    const typeIdx = columnIndex(table.header, '类型');
    const descIdx = columnIndex(table.header, '描述');
    if (nameIdx !== 0 || typeIdx < 0) return null;
    const head = table.rows[0] ? parseMarkerCell(table.rows[0][nameIdx] ?? '') : null;
    if (!head) return null;
    const desc = descIdx >= 0 ? (table.rows[0][descIdx] ?? '').trim() : '';
    // 没名字的 schema 显示成 *anonymous*；有 title 的会显示 title，也拿来当标签
    const isAnon = /^\*?anonymous\*?$/i.test(head.name);
    const label = desc || (isAnon ? '' : head.name);
    variants.push({ label, headType: (table.rows[0][typeIdx] ?? '').trim(), table });
    i = table.end + 1;
    while (i < lines.length && lines[i].trim() === '') i++;
  }
  if (variants.length === 0) return null;
  return { variants, end: i };
}

function renderVariant(
  v: Variant,
  index: number,
  total: number,
  parentPath: string,
  parentSegments: string[],
  headDepth: number,
): string[] {
  const nameIdx = 0;
  const typeIdx = columnIndex(v.table.header, '类型');
  const title = `**${parentPath ? `${parentPath} ` : ''}形状 ${index + 1}/${total}${v.label ? `：${v.label}` : ''}**`;
  const out: string[] = ['', title, ''];
  out.push(`|${v.table.header.join('|')}|`);
  out.push(`|${v.table.header.map(() => '---').join('|')}|`);
  // 祖先栈：主表的段 + 变体表里逐行推进。头行（*anonymous*）那一层不算路径。
  const stack: string[] = parentSegments.slice();
  for (const cells of v.table.rows.slice(1)) {
    const parsed = parseMarkerCell(cells[nameIdx] ?? '');
    if (!parsed) {
      out.push(`|${cells.join('|')}|`);
      continue;
    }
    const segment = isArrayType(cells[typeIdx] ?? '') ? `${parsed.name}[]` : parsed.name;
    stack[parsed.depth] = segment;
    stack.length = parsed.depth + 1;
    const path = [...stack.slice(0, headDepth), ...stack.slice(headDepth + 1)].join('.');
    const rewritten = [...cells];
    rewritten[nameIdx] = path;
    out.push(`|${rewritten.join('|')}|`);
  }
  return out;
}

export function splitOneOfVariants(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  // 最近一张主表在 out 里的位置，用来回填父行类型
  let lastTable: { outStart: number; table: Table } | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (MARKER_RE.test(line.trim()) && lastTable) {
      const parent = lastSchemaRow(lastTable.table);
      const group = parent ? readVariantGroup(lines, i) : null;
      if (parent && group) {
        const { row, segments } = parent;
        const parentPath = segments.join('.');
        const headDepth = row.depth + 1;
        const total = group.variants.length;
        group.variants.forEach((v, idx) => {
          out.push(...renderVariant(v, idx, total, parentPath, segments, headDepth));
        });
        // 变体全是 object → 主表那行从 any 改成 object
        if (group.variants.every((v) => v.headType === 'object')) {
          const typeIdx = columnIndex(lastTable.table.header, '类型');
          const rowLine = lastTable.outStart + 2 + parent.rowIdx;
          const cells = splitCells(out[rowLine]);
          if (cells && typeIdx >= 0 && cells[typeIdx].trim() === 'any') {
            cells[typeIdx] = 'object';
            out[rowLine] = `|${cells.join('|')}|`;
          }
        }
        out.push('');
        i = group.end;
        lastTable = null;
        continue;
      }
    }
    const table = splitCells(line) ? readTable(lines, i) : null;
    if (table && table.start === i) {
      lastTable = { outStart: out.length, table };
      for (let k = table.start; k <= table.end; k++) out.push(lines[k]);
      i = table.end + 1;
      continue;
    }
    // 表和 oneOf 标记之间只允许空行；夹了别的内容就不认这张表当父表
    if (line.trim() !== '') lastTable = null;
    out.push(line);
    i++;
  }
  return out.join('\n');
}

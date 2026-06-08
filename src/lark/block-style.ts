/**
 * Post-push block styler — applies real Lark colors that the markdown/XML import
 * path can't carry.
 *
 * WHY a separate pass: Lark's docx import (`docs +update`) drops inline/block
 * color attributes (proven: v0.5.1 removed dead `text-color`/`background-color`
 * from the XML). But colors DO live on block-level properties and are settable
 * via the docx block API AFTER the doc exists. So once a doc is successfully
 * pushed, we: (1) fetch its blocks, (2) run pluggable style RULES over the block
 * tree to collect per-text-element edits, (3) issue ONE batch_update per doc.
 *
 * Palette (text_color / background_color): 1=red 2=orange 3=yellow 4=green
 * 5=blue … 15≈gray. (Verified live.)
 *
 * Everything here is best-effort polish: any failure (fetch or update) is logged
 * and swallowed by the caller — the doc already has its content; color is extra.
 *
 * The pure functions (parseBlocks / findTables / rule fns / buildBatchUpdate) are
 * unit-tested; only `styleDoc` does I/O (lark-cli api) and is mocked in tests.
 */

import { spawnSync } from 'node:child_process';
import { REQUIRED_CELL_TEXT } from '../renderer/markdown-to-xml.js';

// ── Block-tree types (subset of the docx blocks API we use) ─────────────────

export interface TextElement {
  text_run?: {
    content?: string;
    text_element_style?: Record<string, unknown>;
  };
}

export interface DocBlock {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  text?: { elements?: TextElement[] };
  table?: {
    cells?: string[];
    property?: { column_size?: number; row_size?: number; header_row?: boolean };
  };
}

/** block_type constants we care about. */
export const BLOCK_TYPE = {
  TEXT: 2,
  TABLE: 31,
  TABLE_CELL: 32,
} as const;

/** One text-element edit: set `style` on the element whose content === `content`
 *  inside the given block. `content` must be resent exactly (API requirement). */
export interface ElementEdit {
  blockId: string;
  content: string;
  /** text_element_style to apply, e.g. { text_color: 1 } or { background_color: 3 }. */
  style: Record<string, unknown>;
}

/** A style rule: given the indexed block tree, return the edits it wants. */
export type StyleRule = (ctx: BlockIndex) => ElementEdit[];

/** Indexed view of a doc's block list for rules to query. */
export interface BlockIndex {
  byId: Map<string, DocBlock>;
  all: DocBlock[];
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Concatenated text of a block's text elements. */
export function blockText(b: DocBlock | undefined): string {
  if (!b?.text?.elements) return '';
  return b.text.elements
    .map((e) => e.text_run?.content ?? '')
    .join('');
}

/** Build a queryable index from the raw `.data.items[]` of the blocks list. */
export function indexBlocks(items: DocBlock[]): BlockIndex {
  const byId = new Map<string, DocBlock>();
  for (const b of items) byId.set(b.block_id, b);
  return { byId, all: items };
}

/** First child text block of a table cell (cells hold a text block child). */
function cellText(idx: BlockIndex, cellId: string): { textBlockId: string; text: string } | null {
  const cell = idx.byId.get(cellId);
  if (!cell || cell.block_type !== BLOCK_TYPE.TABLE_CELL) return null;
  const firstChild = (cell.children ?? [])[0];
  if (!firstChild) return null;
  const tb = idx.byId.get(firstChild);
  if (!tb) return null;
  return { textBlockId: tb.block_id, text: blockText(tb) };
}

/**
 * Describe a table's grid: column headers + a `cellAt(row,col)` accessor.
 * Returns null if the block isn't a usable table.
 */
export interface TableGrid {
  cols: number;
  rows: number;
  headers: string[];
  /** flat row-major cell ids */
  cells: string[];
}

export function tableGrid(idx: BlockIndex, table: DocBlock): TableGrid | null {
  if (table.block_type !== BLOCK_TYPE.TABLE) return null;
  const cells = table.table?.cells ?? [];
  const cols = table.table?.property?.column_size ?? 0;
  const rows = table.table?.property?.row_size ?? 0;
  if (cols <= 0 || rows <= 0 || cells.length < cols) return null;
  const headers: string[] = [];
  for (let c = 0; c < cols; c++) {
    const ct = cellText(idx, cells[c]);
    headers.push(ct ? ct.text.trim() : '');
  }
  return { cols, rows, headers, cells };
}

export function findTables(idx: BlockIndex): DocBlock[] {
  return idx.all.filter((b) => b.block_type === BLOCK_TYPE.TABLE);
}

// ── Rule #1: 必填 (required) body cells → red ───────────────────────────────

/**
 * For every field table (header contains `必填`), color each tbody cell in the
 * 必填 column red whose text is the required marker. The HEADER `必填` cell is
 * never touched (we start at row 1). Optional cells (`—`) are skipped.
 */
export function ruleRequiredCellsRed(idx: BlockIndex): ElementEdit[] {
  const edits: ElementEdit[] = [];
  for (const table of findTables(idx)) {
    const grid = tableGrid(idx, table);
    if (!grid) continue;
    const reqCol = grid.headers.findIndex((h) => h === '必填' || /^required$/i.test(h));
    if (reqCol < 0) continue;
    // tbody rows only (skip header row 0) → header 必填 cell never matched.
    for (let r = 1; r < grid.rows; r++) {
      const cellId = grid.cells[r * grid.cols + reqCol];
      if (!cellId) continue;
      const ct = cellText(idx, cellId);
      if (!ct) continue;
      if (ct.text.trim() === REQUIRED_CELL_TEXT) {
        edits.push({ blockId: ct.textBlockId, content: ct.text, style: { text_color: 1 } });
      }
    }
  }
  return edits;
}

/** The default rule set shipped today. Add more (highlight, callout color) here. */
export const DEFAULT_RULES: StyleRule[] = [ruleRequiredCellsRed];

/** Run all rules, de-duplicating edits by (blockId + style keys). */
export function collectEdits(idx: BlockIndex, rules: StyleRule[] = DEFAULT_RULES): ElementEdit[] {
  const out: ElementEdit[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    for (const e of rule(idx)) {
      const key = `${e.blockId}|${JSON.stringify(e.style)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** Build the docx `blocks/batch_update` request body from a list of edits. */
export function buildBatchUpdate(edits: ElementEdit[]): {
  requests: Array<{
    block_id: string;
    update_text_elements: { elements: TextElement[] };
  }>;
} {
  return {
    requests: edits.map((e) => ({
      block_id: e.blockId,
      update_text_elements: {
        elements: [
          {
            text_run: {
              content: e.content,
              text_element_style: e.style,
            },
          },
        ],
      },
    })),
  };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

export interface StyleDocInput {
  /** docx document_id (the leaf's objToken). */
  documentId: string;
  larkBin?: string;
  timeoutMs?: number;
  rules?: StyleRule[];
  /** Pass-through for tests. */
  env?: NodeJS.ProcessEnv;
}

export interface StyleDocResult {
  ok: boolean;
  /** number of text elements styled (0 when nothing matched). */
  styled: number;
  /** populated on failure (best-effort: caller logs as a warning, not a failure). */
  warning?: string;
}

function runLark(
  bin: string,
  args: string[],
  opts: { input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    input: opts.input,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    code: res.status,
  };
}

/** Parse a lark-cli `api` JSON response, tolerating a leading progress line. */
function parseApiJson(stdout: string): any | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

/**
 * Fetch a doc's blocks (paginated) via lark-cli. Returns the merged items, or
 * null on any failure.
 */
export function fetchBlocks(input: StyleDocInput): DocBlock[] | null {
  const bin = input.larkBin ?? 'lark-cli';
  const timeoutMs = input.timeoutMs ?? 60_000;
  const res = runLark(
    bin,
    [
      'api',
      'GET',
      `/open-apis/docx/v1/documents/${input.documentId}/blocks`,
      '--params',
      JSON.stringify({ page_size: 500, document_revision_id: -1 }),
      '--page-all',
    ],
    { timeoutMs, env: input.env },
  );
  if (!res.ok) return null;
  const json = parseApiJson(res.stdout);
  const items = json?.data?.items;
  return Array.isArray(items) ? (items as DocBlock[]) : null;
}

/** Issue ONE batch_update with all edits. Returns true on code 0. */
export function pushBatchUpdate(input: StyleDocInput, edits: ElementEdit[]): boolean {
  if (edits.length === 0) return true;
  const bin = input.larkBin ?? 'lark-cli';
  const timeoutMs = input.timeoutMs ?? 60_000;
  const body = JSON.stringify(buildBatchUpdate(edits));
  const res = runLark(
    bin,
    [
      'api',
      'PATCH',
      `/open-apis/docx/v1/documents/${input.documentId}/blocks/batch_update`,
      '--data',
      '-',
    ],
    { input: body, timeoutMs, env: input.env },
  );
  if (!res.ok) return false;
  const json = parseApiJson(res.stdout);
  return json?.code === 0;
}

/**
 * Full post-push styling pass for one doc: fetch blocks → collect edits → ONE
 * batch_update. Best-effort: never throws; returns a result the caller logs.
 */
export function styleDoc(input: StyleDocInput): StyleDocResult {
  let items: DocBlock[] | null;
  try {
    items = fetchBlocks(input);
  } catch (err) {
    return { ok: false, styled: 0, warning: `block fetch failed: ${(err as Error).message}` };
  }
  if (!items) {
    return { ok: false, styled: 0, warning: 'block fetch returned no items' };
  }
  const idx = indexBlocks(items);
  const edits = collectEdits(idx, input.rules);
  if (edits.length === 0) return { ok: true, styled: 0 };
  try {
    const ok = pushBatchUpdate(input, edits);
    if (!ok) {
      return { ok: false, styled: 0, warning: `batch_update rejected ${edits.length} edit(s)` };
    }
    return { ok: true, styled: edits.length };
  } catch (err) {
    return { ok: false, styled: 0, warning: `batch_update failed: ${(err as Error).message}` };
  }
}

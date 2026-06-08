import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import {
  indexBlocks,
  blockText,
  tableGrid,
  findTables,
  ruleRequiredCellsRed,
  collectEdits,
  buildBatchUpdate,
  fetchBlocks,
  pushBatchUpdate,
  styleDoc,
  type DocBlock,
} from '../src/lark/block-style.js';
import { makeFakeLark, pathWith } from './helpers/fake-lark.js';

// ── Fixture block tree: one field table (params) ────────────────────────────
// Layout (cols=4: 名称 | 类型 | 必填 | 描述, rows=3):
//   header: 名称 类型 必填 描述
//   row1:   roomNo string 必填 房间号   (required)
//   row2:   limit  integer —   条数     (optional)
//
// Each table cell (block_type 32) has one text-block (block_type 2) child.
function textBlock(id: string, content: string): DocBlock {
  return { block_id: id, block_type: 2, text: { elements: [{ text_run: { content } }] } };
}
function cell(id: string, textId: string): DocBlock {
  return { block_id: id, block_type: 32, children: [textId] };
}

function buildFixture(): DocBlock[] {
  const cellTexts = [
    ['c0', 't0', '名称'],
    ['c1', 't1', '类型'],
    ['c2', 't2', '必填'], // HEADER 必填 — must NOT be colored
    ['c3', 't3', '描述'],
    ['c4', 't4', 'roomNo'],
    ['c5', 't5', 'string'],
    ['c6', 't6', '必填'], // row1 required — SHOULD be colored
    ['c7', 't7', '房间号'],
    ['c8', 't8', 'limit'],
    ['c9', 't9', 'integer'],
    ['c10', 't10', '—'], // row2 optional — skipped
    ['c11', 't11', '条数'],
  ];
  const blocks: DocBlock[] = [];
  const cellIds: string[] = [];
  for (const [cid, tid, content] of cellTexts) {
    blocks.push(cell(cid, tid));
    blocks.push(textBlock(tid, content));
    cellIds.push(cid);
  }
  const table: DocBlock = {
    block_id: 'tbl',
    block_type: 31,
    children: cellIds,
    table: { cells: cellIds, property: { column_size: 4, row_size: 3, header_row: true } },
  };
  return [table, ...blocks];
}

describe('block-style pure helpers', () => {
  it('blockText concatenates text_run content', () => {
    expect(blockText(textBlock('x', 'hello'))).toBe('hello');
    expect(blockText(undefined)).toBe('');
  });

  it('tableGrid reads cols/rows/headers', () => {
    const idx = indexBlocks(buildFixture());
    const table = findTables(idx)[0];
    const grid = tableGrid(idx, table)!;
    expect(grid.cols).toBe(4);
    expect(grid.rows).toBe(3);
    expect(grid.headers).toEqual(['名称', '类型', '必填', '描述']);
  });
});

describe('ruleRequiredCellsRed', () => {
  it('colors ONLY tbody 必填 cells red, never the header 必填 cell', () => {
    const idx = indexBlocks(buildFixture());
    const edits = ruleRequiredCellsRed(idx);
    // exactly one edit: row1's required cell text block (t6)
    expect(edits).toEqual([{ blockId: 't6', content: '必填', style: { text_color: 1 } }]);
    // header 必填 (t2) is NOT in the edits
    expect(edits.find((e) => e.blockId === 't2')).toBeUndefined();
    // optional cell (t10 = —) is NOT in the edits
    expect(edits.find((e) => e.blockId === 't10')).toBeUndefined();
  });

  it('handles multiple required rows', () => {
    const blocks = buildFixture();
    // flip row2's optional cell text (t10) to required
    const t10 = blocks.find((b) => b.block_id === 't10')!;
    t10.text!.elements![0].text_run!.content = '必填';
    const edits = ruleRequiredCellsRed(indexBlocks(blocks));
    expect(edits.map((e) => e.blockId).sort()).toEqual(['t10', 't6']);
  });

  it('no-op for a table without a 必填 column', () => {
    // status table: 状态码 | 含义
    const blocks: DocBlock[] = [
      {
        block_id: 'tbl',
        block_type: 31,
        table: { cells: ['c0', 'c1', 'c2', 'c3'], property: { column_size: 2, row_size: 2 } },
      },
      cell('c0', 't0'),
      textBlock('t0', '状态码'),
      cell('c1', 't1'),
      textBlock('t1', '含义'),
      cell('c2', 't2'),
      textBlock('t2', '200'),
      cell('c3', 't3'),
      textBlock('t3', 'OK'),
    ];
    expect(ruleRequiredCellsRed(indexBlocks(blocks))).toEqual([]);
  });
});

describe('collectEdits + buildBatchUpdate', () => {
  it('builds the proven batch_update payload shape', () => {
    const idx = indexBlocks(buildFixture());
    const edits = collectEdits(idx);
    const body = buildBatchUpdate(edits);
    expect(body).toEqual({
      requests: [
        {
          block_id: 't6',
          update_text_elements: {
            elements: [{ text_run: { content: '必填', text_element_style: { text_color: 1 } } }],
          },
        },
      ],
    });
  });

  it('de-duplicates identical (block, style) edits', () => {
    const idx = indexBlocks(buildFixture());
    // two rules both emitting the same edit → one entry
    const dup = collectEdits(idx, [ruleRequiredCellsRed, ruleRequiredCellsRed]);
    expect(dup).toHaveLength(1);
  });
});

// ── I/O against a fake lark-cli ─────────────────────────────────────────────
describe('block-style I/O (fake lark-cli)', () => {
  let fakeDir: string;
  beforeAll(() => {
    fakeDir = makeFakeLark().dir;
  });
  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
  });

  const fixtureJson = () =>
    JSON.stringify({ code: 0, data: { items: buildFixture() } });

  it('fetchBlocks parses .data.items', () => {
    const items = fetchBlocks({
      documentId: 'doc1',
      larkBin: 'lark',
      env: { PATH: pathWith(fakeDir), FAKE_LARK_STDOUT: fixtureJson(), FAKE_LARK_EXIT: '0' },
    });
    expect(items).not.toBeNull();
    expect(items!.length).toBe(buildFixture().length);
  });

  it('fetchBlocks returns null on non-zero exit', () => {
    const items = fetchBlocks({
      documentId: 'doc1',
      larkBin: 'lark',
      env: { PATH: pathWith(fakeDir), FAKE_LARK_STDERR: 'boom', FAKE_LARK_EXIT: '1' },
    });
    expect(items).toBeNull();
  });

  it('pushBatchUpdate returns true on code 0', () => {
    const ok = pushBatchUpdate(
      {
        documentId: 'doc1',
        larkBin: 'lark',
        env: { PATH: pathWith(fakeDir), FAKE_LARK_STDOUT: '{"code":0,"data":{}}', FAKE_LARK_EXIT: '0' },
      },
      [{ blockId: 't6', content: '必填', style: { text_color: 1 } }],
    );
    expect(ok).toBe(true);
  });

  it('pushBatchUpdate is a no-op (true) for empty edits', () => {
    const ok = pushBatchUpdate(
      { documentId: 'doc1', larkBin: 'lark', env: { PATH: pathWith(fakeDir) } },
      [],
    );
    expect(ok).toBe(true);
  });

  it('styleDoc: fetch → collect → update, returns styled count', () => {
    const res = styleDoc({
      documentId: 'doc1',
      larkBin: 'lark',
      env: { PATH: pathWith(fakeDir), FAKE_LARK_STDOUT: fixtureJson(), FAKE_LARK_EXIT: '0' },
    });
    expect(res.ok).toBe(true);
    expect(res.styled).toBe(1);
  });

  it('styleDoc: fetch failure → ok:false warning, never throws', () => {
    const res = styleDoc({
      documentId: 'doc1',
      larkBin: 'lark',
      env: { PATH: pathWith(fakeDir), FAKE_LARK_STDERR: 'nope', FAKE_LARK_EXIT: '1' },
    });
    expect(res.ok).toBe(false);
    expect(res.styled).toBe(0);
    expect(res.warning).toBeTruthy();
  });
});

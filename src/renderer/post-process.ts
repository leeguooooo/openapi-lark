/**
 * Post-process markdown to mitigate 飞书 docx quirks (spec KNOWN_ISSUES).
 *
 * Each transformer is small and isolated so tests can pin them individually.
 */

import { enrichParamsTable } from './constraints.js';

/**
 * KNOWN_ISSUE #2: 表格单元里含 `|` 会破坏 markdown 解析。
 *
 * Strategy: detect tables (header row + separator row + body rows). The separator
 * row gives the canonical column count. For body rows with extra unescaped pipes
 * (i.e. cell content containing `|`), escape the excess so markdown parsers don't
 * fragment the row.
 *
 * We approximate by counting expected delimiters (column count + 1) per row and
 * escaping pipes beyond the boundary on a best-effort basis: any unescaped `|`
 * that increases the cell count past expected gets escaped from the inside out.
 */
function countUnescapedPipes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '|' && (i === 0 || s[i - 1] !== '\\')) n++;
  }
  return n;
}

/**
 * Find the column indices (in the original string) of unescaped `|` characters in `line`.
 */
function pipePositions(line: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && (i === 0 || line[i - 1] !== '\\')) out.push(i);
  }
  return out;
}

/**
 * Decide which pipes in a body row are column delimiters vs content:
 *  - First pipe (leftmost) is always the leading delimiter
 *  - Last pipe (rightmost) is always the trailing delimiter
 *  - For inner pipes, expect `separatorInnerCount` of them as delimiters.
 *    If the row has more inner pipes than that, escape the extras. We pick
 *    the inner pipes WHOSE POSITIONS BEST MATCH the separator's inner pipes
 *    (smallest absolute distance); the unmatched ones are content.
 */
function escapeContentPipes(line: string, separatorPipePositions: number[]): string {
  if (separatorPipePositions.length < 2) return line;
  const linePipes = pipePositions(line);
  if (linePipes.length < 2) return line;
  if (linePipes.length <= separatorPipePositions.length) return line;

  const sepInner = separatorPipePositions.slice(1, -1);
  const lineInnerIdx = linePipes.slice(1, -1); // positions in line
  // Each inner separator pipe claims the closest unclaimed body inner pipe.
  // Walk separator pipes RIGHT-TO-LEFT (codex round-6 Q2): pipes closer to the
  // right are more likely real delimiters; pipes closer to a cell's left edge
  // are more likely content. Right-to-left claim pushes content pipes to the
  // leftmost unmatched slot, which matches human authoring intuition.
  const claimed = new Set<number>();
  for (let s = sepInner.length - 1; s >= 0; s--) {
    const sepPos = sepInner[s];
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = lineInnerIdx.length - 1; i >= 0; i--) {
      if (claimed.has(i)) continue;
      const dist = Math.abs(lineInnerIdx[i] - sepPos);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) claimed.add(bestIdx);
  }
  // Unclaimed inner pipes = content; escape them.
  // Walk right-to-left so earlier indices stay valid.
  let chars = line;
  for (let i = lineInnerIdx.length - 1; i >= 0; i--) {
    if (claimed.has(i)) continue;
    const pos = lineInnerIdx[i];
    chars = chars.slice(0, pos) + '\\|' + chars.slice(pos + 1);
  }
  return chars;
}

export function escapePipesInTables(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let separatorPositions: number[] = [];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const looksLikeTableRow = trimmed.startsWith('|') && trimmed.endsWith('|');
    const looksLikeSeparator =
      looksLikeTableRow && /^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|$/.test(trimmed);

    if (looksLikeSeparator) {
      // Separator row defines canonical column boundaries via pipe positions
      separatorPositions = pipePositions(line);
      // Re-escape the just-emitted header row (we now know the column boundaries)
      if (headerIdx >= 0 && out.length > 0) {
        out[headerIdx] = escapeContentPipes(out[headerIdx], separatorPositions);
      }
      out.push(line);
      headerIdx = -1;
      continue;
    }
    if (looksLikeTableRow && separatorPositions.length > 0) {
      out.push(escapeContentPipes(line, separatorPositions));
      continue;
    }
    if (looksLikeTableRow) {
      // First row before separator — header. Push as-is; will be re-escaped when separator arrives.
      out.push(line);
      headerIdx = out.length - 1;
      continue;
    }
    separatorPositions = [];
    headerIdx = -1;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * KNOWN_ISSUE #3: HTML 内联标签在飞书 docx 中丢失或显示原文。
 * Strip a fixed set of HTML tags from inline text (not code blocks).
 */
export function stripUnsafeHtmlTags(md: string): string {
  const unsafe = ['details', 'summary', 'br', 'sub', 'sup'];
  // skip code blocks
  const blocks: string[] = [];
  const placeholder = '\0CODEBLOCK\0';
  const withoutCode = md.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return placeholder + (blocks.length - 1);
  });

  let processed = withoutCode;
  for (const tag of unsafe) {
    const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    const close = new RegExp(`</${tag}>`, 'gi');
    processed = processed.replace(open, '').replace(close, '');
  }
  // restore code blocks
  return processed.replace(/\0CODEBLOCK\0(\d+)/g, (_, idx: string) => blocks[Number(idx)]);
}

/**
 * Strip widdershins-emitted boilerplate that is meaningless once we've turned
 * off code samples / multi-language tabs.
 */
export function stripWiddershinsBoilerplate(md: string): string {
  let out = md;
  // Lead-in blockquote ("Scroll down for code samples..."): widdershins emits
  // it twice per operation (once near top, once before each response example).
  out = out.replace(
    /^\s*>\s*Scroll down for code samples, example requests and responses\..*$/gm,
    '',
  );
  // "Code samples" sub-header (we turned code samples off; this header is dead)
  out = out.replace(/^\s*>\s*Code samples\s*$/gm, '');
  // Generator comment
  out = out.replace(/<!--\s*Generator:\s*Widdershins[^>]*-->/g, '');
  // Empty "Example responses" / "200 Response" callouts that precede schema-only
  // sections become noise without examples
  out = out.replace(/^\s*>\s*Example responses\s*$/gm, '');
  // Operation anchor links (`<a id="opIdXxx"></a>`) — purely for legacy
  // single-page nav; we have per-endpoint wiki nodes now
  out = out.replace(/<a\s+id="opId[^"]*"[^>]*>\s*<\/a>/g, '');
  // Empty <h1>/<h2>/<h3> that only contain version/whitespace (widdershins
  // emits `<h1 id="api"> v1.0.0</h1>` when info.title is intentionally blank)
  out = out.replace(/<h([1-6])[^>]*>\s*v?\d+(?:\.\d+){1,3}\s*<\/h\1>/gi, '');
  out = out.replace(/<h([1-6])[^>]*>\s*<\/h\1>/gi, '');
  // Tag-level intro headings inside an endpoint doc (id="api--xxx").
  // Endpoint mode renders one operation per doc — the tag header is the wiki
  // node's parent, repeating it inside the doc is noise.
  out = out.replace(/<h([1-6])[^>]*id="api--[^"]*"[^>]*>[\s\S]*?<\/h\1>/g, '');
  // The "<h1 id="api">..." that widdershins emits for info.title (empty too
  // when we suppress it) — also strip when content is just whitespace
  out = out.replace(/<h([1-6])[^>]*id="api"[^>]*>\s*<\/h\1>/gi, '');
  // widdershins <aside> blocks: "This operation does not require authentication"
  // and similar are useless when we render per-endpoint
  out = out.replace(/<aside[^>]*>[\s\S]*?<\/aside>/g, '');
  // Global preamble "Base URLs:" list — widdershins emits the spec's servers as
  // a bullet list at the top of every doc. In endpoint mode the request example
  // already shows the concrete base URL; the bare list is noise.
  out = out.replace(/^Base URLs:\s*$\n+(?:^[ \t]*[*-] .*$\n?|^[ \t]*$\n)+/gm, '');
  // Global "# Authentication" section — lists EVERY scheme in the spec. We now
  // render a per-operation 「鉴权」 section + a top callout that name the exact
  // header THIS endpoint needs, so the global block is redundant noise. Strip the
  // `# Authentication` heading plus its following bullet list / blank lines.
  out = out.replace(
    /^#\s+Authentication\s*$\n+(?:^[ \t]*[*-].*$\n?|^[ \t]*$\n)+/gm,
    '',
  );
  // Auto-generated operation heading "## post__otp_applegame": when an operation
  // has NO operationId, widdershins synthesizes a heading from method + path
  // (path `/` → `_`), e.g. `## post__otp_applegame`. It's ugly and redundant —
  // endpoint-mode leaf docs already carry a proper H1 (`<summary> — <METHOD> <path>`)
  // locked as the docx title. Strip the whole line. Match `<hashes> <method>__<rest>`
  // where method is a real HTTP verb and is followed by exactly two underscores.
  // Case-insensitive so `POST__` / `Get__` are also caught. We do NOT touch tag
  // headings, Chinese/English section headings, or code (the `<verb>__` shape is
  // specific to widdershins' synthesized op ids).
  out = out.replace(
    /^#{1,6}[ \t]+(?:get|post|put|delete|patch|head|options|trace)__\S+[ \t]*$\n?/gim,
    '',
  );
  // "> NNN Response" callout + the JSON code block that follows. Widdershins
  // tries to synthesize an "example response" but for schemas using allOf /
  // discriminator / refs, it dumps the SCHEMA DEFINITION (keys like type/
  // required/properties) instead of a value — confusing and wrong. The
  // response schema table already captures the structure properly, so we
  // remove the broken sample. We match `> <status> Response\n\n```json … ```\n`
  out = out.replace(
    /^>\s*\d{3}\s+Response\s*$\n+```[a-zA-Z0-9]*\n[\s\S]*?\n```\s*$/gm,
    '',
  );
  return out;
}

/**
 * Split a markdown table row into its cell contents. Returns null when the line
 * is not a `| ... |` table row. Leading/trailing pipes are stripped so the
 * returned array contains only real cells (no empty edge entries). Cells are
 * NOT trimmed here — callers decide.
 *
 * Note: this is a best-effort split on unescaped `|`. Rows that embed `\|` in
 * cell content keep the escaped pipe inside the cell (we only split on `|` that
 * is not preceded by a backslash).
 */
function splitTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  // Strip exactly one leading and one trailing pipe, then split on unescaped `|`.
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

/**
 * widdershins noise #A: the "root body wrapper" row in POST parameter tables.
 *
 * For a request body, widdershins emits one row representing the whole JSON body
 * object BEFORE the real `» field` rows:
 *
 *   | body | body | object | true | none |   <- meaningless wrapper, remove
 *   | » mobile | body | string | true | ... | <- real field, keep
 *
 * We delete a body row IFF its FIRST cell trims to exactly `body` (no `»`
 * prefix), its SECOND cell (location/「位置」) trims to `body`, and its THIRD
 * cell (type/「类型」) trims to `object`. This is keyed on cell *semantics*, not
 * column count, so tables with an extra 「约束」/Restrictions column still match.
 *
 * `» body` / `»» body` field rows are preserved (their first cell is not exactly
 * `body`). Body schemas that are arrays (type `array`, not `object`) are left
 * alone — only the object wrapper is removed.
 */
export function stripRootBodyParamRow(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const cells = splitTableCells(line);
    if (cells && cells.length >= 3) {
      const c0 = cells[0].trim();
      const c1 = cells[1].trim();
      const c2 = cells[2].trim();
      if (c0 === 'body' && c1 === 'body' && c2 === 'object') {
        // Drop this row entirely.
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * widdershins noise #B: literal `none` placeholders in table cells.
 *
 * widdershins fills empty 描述/约束/必填 cells with the literal string `none`.
 * Replace any table cell whose trimmed content is exactly `none` with an empty
 * cell. We operate cell-by-cell on `| ... |` rows only, so prose / code / words
 * like `none-of-this` are never touched. The separator row (`|-|-|`) has no
 * `none` cells so it is unaffected; we also skip rows that look like separators
 * defensively.
 */
export function clearNonePlaceholders(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const cells = splitTableCells(line);
    if (!cells) {
      out.push(line);
      continue;
    }
    // Skip separator rows (cells are all dashes/colons) — nothing to clear.
    const isSeparator = cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
    if (isSeparator) {
      out.push(line);
      continue;
    }
    let changed = false;
    const newCells = cells.map((c) => {
      if (c.trim() === 'none') {
        changed = true;
        // Preserve a single space padding so the cell reads `| |` not `||`.
        return ' ';
      }
      return c;
    });
    if (!changed) {
      out.push(line);
      continue;
    }
    out.push('|' + newCells.join('|') + '|');
  }
  return out.join('\n');
}

/**
 * For endpoint-mode leaf docs: the docx title (locked via lockTitleInMarkdown)
 * already carries the summary. Widdershins also emits the summary as a `*X*`
 * emphasis line right under the `## <operationId>` heading — redundant.
 *
 * This transform removes the `## <opid-or-summary>` operation heading (the doc
 * title covers it) and the `*<summary>*` em line that follows.
 *
 * Returns md unchanged when no obvious operation pattern is detected (e.g.
 * tag-index docs that contain multiple operations).
 */
export function collapseRedundantOperationIntro(md: string, summary?: string): string {
  if (!summary) return md;
  const sumEsc = summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ## <summary>\n`METHOD path`\n\n*<summary>*\n  →  `METHOD path`\n
  // (Both summary line and em-summary line collapsed)
  let out = md;
  // Drop "## <summary>" when it precedes the method/path code span
  out = out.replace(
    new RegExp(
      `^## ${sumEsc}\\s*\\n(?=\\s*\`[A-Z]+ \\/)`,
      'm',
    ),
    '',
  );
  // Drop standalone "*<summary>*" emphasis line
  out = out.replace(
    new RegExp(`^\\*${sumEsc}\\*\\s*$`, 'gm'),
    '',
  );
  // Collapse 3+ blank lines after removals
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

/**
 * Translate widdershins-emitted English section headings + table headers to
 * Chinese. Limited to widdershins' standard vocabulary so we don't accidentally
 * mangle user-authored content that happens to use the same words.
 */
export function localizeHeadings(md: string): string {
  let out = md;
  // Section vocab — same translation applies to both markdown and HTML headings
  const VOCAB: Array<[string, string]> = [
    ['Parameters', '参数'],
    ['Body parameter', '请求体示例'],
    ['Responses', '响应'],
    ['Response Schema', '响应 Schema'],
    ['Response Headers', '响应头'],
    ['Enumerated Values', '枚举值'],
    ['Detailed descriptions', '详细说明'],
    ['Authentication', '鉴权'],
    ['Properties', '字段'],
    ['Schemas', 'Schema 定义'],
  ];
  for (const [en, zh] of VOCAB) {
    // ## / ### markdown headings (line-start only)
    out = out.replace(new RegExp(`^(#{2,6}) ${en}\\s*$`, 'gm'), `$1 ${zh}`);
    // <h2>..</h2> / <h3>..</h3> / etc. HTML headings (widdershins emits these
    // for operation sub-sections in some templates)
    out = out.replace(
      new RegExp(`(<h([1-6])[^>]*>)\\s*${en}\\s*(</h\\2>)`, 'g'),
      `$1${zh}$3`,
    );
  }
  // Table headers that widdershins always emits (Name | Type | Required | ... )
  // Only rewrite when the four-column "Parameters" or "Properties" pattern is
  // recognized — avoids touching user content.
  out = out.replace(
    /\|\s*Name\s*\|\s*In\s*\|\s*Type\s*\|\s*Required\s*\|\s*Description\s*\|/g,
    '| 名称 | 位置 | 类型 | 必填 | 描述 |',
  );
  out = out.replace(
    /\|\s*Name\s*\|\s*Type\s*\|\s*Required\s*\|\s*Restrictions\s*\|\s*Description\s*\|/g,
    '| 名称 | 类型 | 必填 | 约束 | 描述 |',
  );
  out = out.replace(
    /\|\s*Status\s*\|\s*Meaning\s*\|\s*Description\s*\|\s*Schema\s*\|/g,
    '| 状态码 | 含义 | 描述 | Schema |',
  );
  // Enum table header (widdershins emits `|Parameter|Value|` for the
  // "Enumerated Values" section — the only un-localized header left).
  out = out.replace(
    /\|\s*Parameter\s*\|\s*Value\s*\|/g,
    '| 参数 | 取值 |',
  );
  return out;
}

/**
 * widdershins fills the 响应 table's Schema column with the literal `Inline`
 * (no link target) for inline/allOf schemas — untranslated and useless. Replace
 * the cell value with a pointer to the 响应 Schema section below. Operates only
 * on the 状态码|含义|描述|Schema table body rows.
 */
export function localizeInlineSchemaCell(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inResponseTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/\|\s*状态码\s*\|\s*含义\s*\|\s*描述\s*\|\s*Schema\s*\|/.test(trimmed)) {
      inResponseTable = true;
      out.push(line);
      continue;
    }
    if (inResponseTable) {
      if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
        inResponseTable = false;
        out.push(line);
        continue;
      }
      // Replace a trailing `| Inline |` cell with the localized pointer.
      out.push(line.replace(/\|\s*Inline\s*\|\s*$/, '| 见下方响应 Schema |'));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Replace `## <operationId>` headings with `## <summary>` for operations whose
 * summary is set. Widdershins uses operationId as the per-operation H2 by
 * default — opaque to Chinese readers.
 */
export function replaceOperationIdHeadings(md: string, api: any): string {
  const map: Record<string, string> = {};
  const paths = (api?.paths ?? {}) as Record<string, any>;
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const op of Object.values(pathItem as Record<string, any>)) {
      if (
        op &&
        typeof op === 'object' &&
        typeof (op as any).operationId === 'string' &&
        typeof (op as any).summary === 'string' &&
        (op as any).summary.trim()
      ) {
        map[(op as any).operationId] = (op as any).summary.trim();
      }
    }
  }
  if (Object.keys(map).length === 0) return md;
  return md.replace(/^(#{1,6})\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/gm, (full, hashes, ident) => {
    if (map[ident]) return `${hashes} ${map[ident]}`;
    return full;
  });
}

/**
 * Run all post-processors in a defined order. `api` is optional; supply it to
 * enable operationId→summary heading replacement.
 *
 * `singleOperationSummary` enables the redundant-intro collapse (only safe for
 * endpoint-mode leaf docs where there's exactly one operation).
 */
export function postProcess(md: string, api?: any, singleOperationSummary?: string): string {
  let out = md;
  out = stripUnsafeHtmlTags(out);
  out = stripWiddershinsBoilerplate(out);
  // Table noise from widdershins: drop the root body wrapper row, blank out
  // literal `none` cells. Run before pipe-escaping so cell splitting sees the
  // raw rows.
  out = stripRootBodyParamRow(out);
  out = clearNonePlaceholders(out);
  out = localizeHeadings(out);
  out = localizeInlineSchemaCell(out);
  if (api) out = replaceOperationIdHeadings(out, api);
  // Enrich the parameters table's 约束 column from the parsed schema (widdershins
  // drops minimum/maximum/default/pattern/…). Needs the dereferenced api.
  if (api) out = enrichParamsTable(out, api);
  if (singleOperationSummary) {
    out = collapseRedundantOperationIntro(out, singleOperationSummary);
  }
  out = escapePipesInTables(out);
  // Final collapse of any blank-line runs left by other transforms
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

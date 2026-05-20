/**
 * Post-process markdown to mitigate 飞书 docx quirks (spec KNOWN_ISSUES).
 *
 * Each transformer is small and isolated so tests can pin them individually.
 */

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
 * Run all post-processors in a defined order.
 */
export function postProcess(md: string): string {
  let out = md;
  out = stripUnsafeHtmlTags(out);
  out = escapePipesInTables(out);
  return out;
}

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

function escapeExcessPipes(line: string, expectedPipes: number): string {
  const current = countUnescapedPipes(line);
  if (current <= expectedPipes) return line;
  let excess = current - expectedPipes;
  // Find the first pipe that is NOT the leading/trailing delimiter and escape it.
  // We walk from index after first pipe to before last pipe.
  const firstPipe = line.indexOf('|');
  const lastPipe = line.lastIndexOf('|');
  if (firstPipe === lastPipe) return line;
  const chars = line.split('');
  // Walk inner pipes left-to-right; escape until we drop to expected count.
  // Skip the outermost two (delimiters) by tracking position vs first/last.
  for (let i = firstPipe + 1; i < lastPipe && excess > 0; i++) {
    if (chars[i] === '|' && chars[i - 1] !== '\\') {
      // Heuristic: if both neighbors are whitespace, this is likely a column delimiter — skip.
      const leftWs = /\s/.test(chars[i - 1] ?? '');
      const rightWs = /\s/.test(chars[i + 1] ?? '');
      if (leftWs && rightWs) continue;
      chars[i] = '\\|';
      excess--;
    }
  }
  return chars.join('');
}

export function escapePipesInTables(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let expectedPipes = 0;
  let prevWasHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const looksLikeTableRow = trimmed.startsWith('|') && trimmed.endsWith('|');
    const looksLikeSeparator =
      looksLikeTableRow && /^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|$/.test(trimmed);

    if (looksLikeSeparator) {
      // Separator row defines canonical column count
      expectedPipes = countUnescapedPipes(trimmed);
      out.push(line);
      prevWasHeader = false;
      continue;
    }
    if (looksLikeTableRow && prevWasHeader) {
      // Header row already emitted; this is the second table row before we saw a separator.
      // Treat the header row's pipe count as canonical.
      expectedPipes = countUnescapedPipes(lines[i - 1].trim());
    }
    if (looksLikeTableRow && expectedPipes > 0) {
      out.push(escapeExcessPipes(line, expectedPipes));
      continue;
    }
    if (looksLikeTableRow) {
      // First row before separator — likely the header. Buffer pipe count for next row.
      out.push(line);
      prevWasHeader = true;
      continue;
    }
    expectedPipes = 0;
    prevWasHeader = false;
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

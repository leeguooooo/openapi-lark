import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

export interface HeadingWarning {
  from: number;
  to: number;
  line: number;
  text: string;
}

export interface HeadingWarningGroup {
  from: number;
  to: number;
  /** Common normalized text pattern across grouped warnings (e.g. "Enumerated Values") */
  pattern: string;
  count: number;
  /** Up to 3 sample line numbers to help users locate occurrences */
  sampleLines: number[];
}

/**
 * Group warnings by (from, to, text) so noisy widdershins outputs collapse:
 *   "Enumerated Values H2→H4 ×189 (lines 42358, 43249, 43473, …)"
 * rather than dumping 200 nearly-identical lines.
 */
export function groupHeadingWarnings(warnings: HeadingWarning[]): HeadingWarningGroup[] {
  const buckets = new Map<string, HeadingWarningGroup>();
  for (const w of warnings) {
    const key = `${w.from}>${w.to}:${w.text}`;
    let g = buckets.get(key);
    if (!g) {
      g = { from: w.from, to: w.to, pattern: w.text, count: 0, sampleLines: [] };
      buckets.set(key, g);
    }
    g.count++;
    if (g.sampleLines.length < 3) g.sampleLines.push(w.line);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count);
}

/**
 * Walk markdown headings and warn on level jumps > 1 (e.g. H2 → H4).
 * Returns warnings; does NOT modify the markdown (per spec KNOWN_ISSUES #5,
 * auto-fix produces visible blank headings in 飞书 docx).
 */
export function detectHeadingJumps(md: string): HeadingWarning[] {
  const tree = unified().use(remarkParse).parse(md);
  const warnings: HeadingWarning[] = [];
  let prev = 0;
  visit(tree, 'heading', (node: any) => {
    const level = node.depth as number;
    if (prev > 0 && level - prev > 1) {
      const text = (node.children ?? [])
        .map((c: any) => (typeof c.value === 'string' ? c.value : ''))
        .join('')
        .slice(0, 80);
      warnings.push({
        from: prev,
        to: level,
        line: node.position?.start?.line ?? 0,
        text,
      });
    }
    prev = level;
  });
  return warnings;
}

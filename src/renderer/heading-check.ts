import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

export interface HeadingWarning {
  from: number;
  to: number;
  line: number;
  text: string;
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

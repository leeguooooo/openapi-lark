import type { WikiChild } from './wiki.js';
import { extractEndpointIdentity } from '../node-map.js';

/**
 * Guard against a mis-configured `docToken` that points at a shared / space-root
 * wiki node instead of a project-dedicated parent.
 *
 * Why this matters: endpoint-mode sync creates this project's tag/group/leaf
 * nodes as children of `docToken`, and the end-of-sync zombie report flags
 * EVERY unclaimed child under that parent. If `docToken` accidentally points at
 * a node shared with other projects (or the space root), then (a) this project's
 * tag nodes pollute that shared node, and (b) all unrelated sibling docs get
 * mis-reported as zombies — which would be catastrophic if a future `--prune`
 * acted on them.
 *
 * Detection heuristic: a child is "recognized" if its title matches one of the
 * expected tag titles for this spec, OR it is endpoint-leaf-shaped (its title
 * embeds a `METHOD /path`, i.e. it was created by some sync run). Everything
 * else is "foreign". When a parent holds many children and the overwhelming
 * majority are foreign, the docToken is very likely wrong.
 *
 * This is a WARNING signal only — never blocks sync. Returns null when no
 * misconfiguration is suspected.
 */
export interface MisconfiguredParentReport {
  totalCount: number;
  foreignCount: number;
  /** Up to a few sample foreign titles, for the warning message. */
  foreignTitles: string[];
  foreignFraction: number;
}

export interface DetectMisconfiguredParentOptions {
  children: WikiChild[];
  expectedTagTitles: string[];
  /** Don't warn unless the parent has at least this many children. Default 5. */
  minChildren?: number;
  /** Warn when foreign/total reaches this fraction. Default 0.8. */
  foreignFractionThreshold?: number;
}

export function detectMisconfiguredParent(
  opts: DetectMisconfiguredParentOptions,
): MisconfiguredParentReport | null {
  const minChildren = opts.minChildren ?? 5;
  const threshold = opts.foreignFractionThreshold ?? 0.8;

  const total = opts.children.length;
  if (total < minChildren) return null;

  const expected = new Set(
    opts.expectedTagTitles.map((t) => t.trim().toLowerCase()),
  );

  const foreignTitles: string[] = [];
  for (const c of opts.children) {
    const key = c.title.trim().toLowerCase();
    const matchesExpectedTag = expected.has(key);
    const looksLikeEndpointLeaf = extractEndpointIdentity(c.title) !== null;
    if (!matchesExpectedTag && !looksLikeEndpointLeaf) {
      foreignTitles.push(c.title);
    }
  }

  const foreignCount = foreignTitles.length;
  const foreignFraction = foreignCount / total;
  if (foreignFraction < threshold) return null;

  return {
    totalCount: total,
    foreignCount,
    foreignFraction,
    foreignTitles: foreignTitles.slice(0, 5),
  };
}

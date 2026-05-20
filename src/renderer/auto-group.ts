import type { EndpointSlice } from './split-by-tag.js';

/**
 * Decide whether a tag bucket benefits from an additional path-prefix
 * sub-grouping level, and compute the groups when it does.
 *
 * Heuristic:
 *   1. < 8 endpoints in the tag → keep flat (3-level tree).
 *   2. Otherwise compute the longest common path prefix across all endpoints
 *      in the tag, then group by the next segment after the prefix.
 *   3. Segments that begin with `{` (path parameter) cannot be group keys —
 *      those endpoints become "singletons" (hoisted directly under the tag).
 *   4. Any group with only 1 endpoint is also hoisted to singletons.
 *   5. If fewer than 2 multi-endpoint groups remain, abandon grouping
 *      (output flat). Otherwise output the 4-level structure.
 *
 * The auto behavior is intentionally conservative: when in doubt, keep flat.
 */

export interface AutoGroupResult {
  /** When non-empty, render a 4-level structure: tag → group → endpoint */
  groups: Record<string, EndpointSlice[]>;
  /** Endpoints that should be placed directly under the tag (flat), even
   *  when grouping is active for siblings. */
  singletons: EndpointSlice[];
  /** Title for each group key (defaults to the path segment itself); future
   *  config-driven overrides plug in here. */
  groupTitles: Record<string, string>;
}

const MIN_ENDPOINTS_FOR_GROUPING = 8;
const MIN_MULTI_GROUPS = 2;

export function autoGroupEndpoints(slices: EndpointSlice[]): AutoGroupResult {
  if (slices.length < MIN_ENDPOINTS_FOR_GROUPING) {
    return { groups: {}, singletons: slices, groupTitles: {} };
  }
  const prefix = longestCommonPathPrefix(slices.map((s) => s.path));
  const bucket = new Map<string, EndpointSlice[]>();
  const singletons: EndpointSlice[] = [];
  for (const s of slices) {
    const rest = (s.path.startsWith(prefix) ? s.path.slice(prefix.length) : s.path).replace(
      /^\/+/,
      '',
    );
    const firstSeg = rest.split('/')[0] ?? '';
    if (!firstSeg || firstSeg.startsWith('{')) {
      singletons.push(s);
      continue;
    }
    if (!bucket.has(firstSeg)) bucket.set(firstSeg, []);
    bucket.get(firstSeg)!.push(s);
  }
  // Hoist single-endpoint groups
  const multi = new Map<string, EndpointSlice[]>();
  for (const [k, arr] of bucket) {
    if (arr.length === 1) singletons.push(arr[0]);
    else multi.set(k, arr);
  }
  if (multi.size < MIN_MULTI_GROUPS) {
    return { groups: {}, singletons: slices, groupTitles: {} };
  }
  const groupTitles: Record<string, string> = {};
  for (const k of multi.keys()) groupTitles[k] = k;
  return {
    groups: Object.fromEntries(multi),
    singletons,
    groupTitles,
  };
}

/**
 * Longest common path prefix at segment boundaries.
 *   ['/api/a/x', '/api/a/y', '/api/b'] → '/api/'
 *   ['/foo', '/bar'] → ''
 *   single element returns dirname (so we still group by next segment)
 */
export function longestCommonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) {
    const i = paths[0].lastIndexOf('/');
    return i <= 0 ? '' : paths[0].slice(0, i + 1);
  }
  const segLists = paths.map((p) => p.split('/'));
  const min = Math.min(...segLists.map((l) => l.length));
  const common: string[] = [];
  for (let i = 0; i < min; i++) {
    const v = segLists[0][i];
    if (segLists.every((l) => l[i] === v)) common.push(v);
    else break;
  }
  return common.length > 0 ? common.join('/') + (common.length > 0 && common[common.length - 1] !== '' ? '/' : '') : '';
}

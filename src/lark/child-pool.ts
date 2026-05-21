import type { WikiChild } from './wiki.js';
import { extractEndpointIdentity } from '../node-map.js';

/**
 * Pool of unclaimed wiki children, indexed three ways for cascade matching:
 *
 *   1. byNodeToken — direct lookup when node-map.json knows the exact token.
 *      Most reliable; survives any title change.
 *   2. byEndpointIdentity — `METHOD path` extracted from the existing wiki
 *      title. Survives summary changes (the original zombie-bug fix).
 *   3. byTitle — lowercased full-title match. Legacy path; needed for
 *      tag/group nodes whose identity isn't embedded in the title.
 *
 * A single WikiChild may appear in 1, 2, or 3 indices. `pop*` methods always
 * remove from ALL of them to keep the indices consistent.
 *
 * Construct via `buildChildPool(children)`; never mutate `byTitle`/`byEndpointIdentity`/
 * `byNodeToken` directly from outside.
 */
export interface ChildPool {
  byTitle: Map<string, WikiChild[]>;
  byEndpointIdentity: Map<string, WikiChild>;
  byNodeToken: Map<string, WikiChild>;
}

export function buildChildPool(children: WikiChild[]): ChildPool {
  const byTitle = new Map<string, WikiChild[]>();
  const byEndpointIdentity = new Map<string, WikiChild>();
  const byNodeToken = new Map<string, WikiChild>();
  for (const c of children) {
    // by-title
    const k = c.title.trim().toLowerCase();
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k)!.push(c);
    // by-endpoint-identity (best-effort, only if regex matches)
    const id = extractEndpointIdentity(c.title);
    if (id && !byEndpointIdentity.has(id)) {
      // If two existing nodes happen to share the same identity, the first
      // one wins; the duplicate stays in byTitle and gets reported as a
      // zombie at end-of-sync.
      byEndpointIdentity.set(id, c);
    }
    // by-node-token (always)
    byNodeToken.set(c.nodeToken, c);
  }
  return { byTitle, byEndpointIdentity, byNodeToken };
}

/** Remove a specific child from all three indices. */
function removeFromPool(pool: ChildPool, child: WikiChild): void {
  // by-title
  const k = child.title.trim().toLowerCase();
  const arr = pool.byTitle.get(k);
  if (arr) {
    const i = arr.indexOf(child);
    if (i >= 0) {
      arr.splice(i, 1);
      if (arr.length === 0) pool.byTitle.delete(k);
    }
  }
  // by-endpoint-identity
  const id = extractEndpointIdentity(child.title);
  if (id && pool.byEndpointIdentity.get(id) === child) {
    pool.byEndpointIdentity.delete(id);
  }
  // by-node-token
  pool.byNodeToken.delete(child.nodeToken);
}

/** Pop the child registered under `nodeToken`. Returns undefined if absent. */
export function popByNodeToken(pool: ChildPool, nodeToken: string): WikiChild | undefined {
  const c = pool.byNodeToken.get(nodeToken);
  if (!c) return undefined;
  removeFromPool(pool, c);
  return c;
}

/**
 * Pop the child whose title contains `METHOD path` matching `identity`.
 * Use this when node-map has no entry and we want to recover identity from
 * the existing title (typical after upgrading from a pre-node-map version).
 */
export function popByEndpointIdentity(
  pool: ChildPool,
  identity: string,
): WikiChild | undefined {
  const c = pool.byEndpointIdentity.get(identity);
  if (!c) return undefined;
  removeFromPool(pool, c);
  return c;
}

/**
 * Pop by full title. Mirrors the original `popFromPool` behavior:
 *   1. exact lowercased title
 *   2. inverse "X — Y" / "Y — X" swap (v1.3 → v1.4 leaf-title order flip)
 *   3. zombie names ("untitled", "authentication") created by prior failed sync
 *
 * Returns undefined if no match.
 */
export function popByTitle(pool: ChildPool, title: string): WikiChild | undefined {
  const k = title.trim().toLowerCase();
  const arr = pool.byTitle.get(k);
  if (arr && arr.length > 0) {
    const c = arr[0];
    removeFromPool(pool, c);
    return c;
  }
  // Inverse-order match: "X — Y" and "Y — X" carry the same operation but
  // different title order. v1.4 reversed the default order (summary first),
  // so existing wiki nodes from v1.3 are titled "METHOD path — summary" and
  // would no longer match new "summary — METHOD path" titles. Try the swap.
  const parts = title.split(' — ');
  if (parts.length === 2) {
    const swapped = `${parts[1].trim()} — ${parts[0].trim()}`.toLowerCase();
    const swapArr = pool.byTitle.get(swapped);
    if (swapArr && swapArr.length > 0) {
      const c = swapArr[0];
      removeFromPool(pool, c);
      return c;
    }
  }
  // Zombie recovery (titles clobbered by prior failed sync)
  for (const zk of ['untitled', 'authentication']) {
    const z = pool.byTitle.get(zk);
    if (z && z.length > 0) {
      const c = z[0];
      removeFromPool(pool, c);
      return c;
    }
  }
  return undefined;
}

/**
 * Cascade: try the three strategies in priority order, return first hit.
 * Convenience for the common leaf flow (node-map → identity → legacy title).
 */
export function popByCascade(
  pool: ChildPool,
  opts: { nodeToken?: string; endpointIdentity?: string; title?: string },
): WikiChild | undefined {
  if (opts.nodeToken) {
    const c = popByNodeToken(pool, opts.nodeToken);
    if (c) return c;
  }
  if (opts.endpointIdentity) {
    const c = popByEndpointIdentity(pool, opts.endpointIdentity);
    if (c) return c;
  }
  if (opts.title) {
    const c = popByTitle(pool, opts.title);
    if (c) return c;
  }
  return undefined;
}

/** All children still in the pool — used to report zombies at end of sync. */
export function remainingChildren(pool: ChildPool): WikiChild[] {
  return [...pool.byNodeToken.values()];
}

import {
  loadAutoTokens,
  saveAutoTokens,
  lookupAutoToken,
  upsertAutoToken,
} from '../auto-tokens.js';
import {
  resolveWikiNode,
  listWikiChildren,
  createWikiChild,
  WikiError,
  type WikiChild,
} from '../lark/wiki.js';
import type { Config, ServiceConfig } from '../types.js';

/**
 * For each service whose docToken is missing, reuse (from cache OR from the
 * parent's existing children by title) or auto-create a child wiki node under
 * the shared parentDocToken.
 *
 * Mutates `services` in-place: each service ends up with a non-empty docToken.
 *
 * Persists the resolved token → service-name mapping in
 * `.openapi-lark/auto-tokens.json` so subsequent sync runs reuse the same
 * child node instead of creating new ones.
 *
 * The title-match fallback is what makes sync safe across machines/users:
 * auto-tokens.json is gitignored, so a teammate (or a fresh clone) starts with
 * an empty cache. Without the fallback, every cache miss created a brand-new
 * same-title child under the parent — duplicating the entire doc tree.
 *
 * Throws if a service is missing docToken AND config.parentDocToken is also
 * unset (this should be caught earlier by schema validation but we double-check).
 */
export interface ResolveDocTokenDeps {
  resolveNode: typeof resolveWikiNode;
  listChildren: typeof listWikiChildren;
  createChild: typeof createWikiChild;
}

const defaultDeps: ResolveDocTokenDeps = {
  resolveNode: resolveWikiNode,
  listChildren: listWikiChildren,
  createChild: createWikiChild,
};

export function resolveDocTokens(
  basedir: string,
  config: Config,
  larkBin: string = 'lark-cli',
  deps: ResolveDocTokenDeps = defaultDeps,
): { created: number; reused: number; assigned: number } {
  const stats = { created: 0, reused: 0, assigned: 0 };
  const needsAuto = config.services.filter((s) => !s.docToken);
  if (needsAuto.length === 0) return stats;

  if (!config.parentDocToken) {
    throw new Error(
      `${needsAuto.length} service(s) without docToken but no parentDocToken set. ` +
        `Either add docToken to each service OR set top-level parentDocToken.`,
    );
  }

  // Resolve the shared parent once
  let parent;
  try {
    parent = deps.resolveNode(config.parentDocToken, larkBin);
  } catch (err) {
    throw new Error(
      `failed to resolve parentDocToken "${config.parentDocToken}": ${(err as Error).message}`,
    );
  }

  const auto = loadAutoTokens(basedir);
  let dirty = false;

  // Title pool of the parent's existing children, listed lazily on the first
  // cache miss. Lets a fresh checkout (no auto-tokens.json) adopt the child a
  // teammate's sync already created instead of duplicating it.
  let titlePool: Map<string, WikiChild[]> | null = null;
  const claimByTitle = (title: string): WikiChild | undefined => {
    if (titlePool === null) {
      try {
        titlePool = buildTitlePool(deps.listChildren(parent.spaceId, parent.nodeToken, larkBin));
      } catch (err) {
        // Listing failed (permissions / transient) — keep the historical
        // create-on-miss behavior rather than aborting the sync.
        process.stderr.write(
          `[sync] ⚠ list children of parentDocToken failed (${(err as Error).message.split('\n')[0]}); ` +
            `cannot dedupe by title, may create a new child\n`,
        );
        titlePool = new Map();
      }
    }
    const arr = titlePool.get(title.trim().toLowerCase());
    return arr && arr.length > 0 ? arr.shift() : undefined;
  };

  for (const svc of needsAuto) {
    const cached = lookupAutoToken(auto, svc.name);
    if (cached && cached.parentDocToken === config.parentDocToken) {
      svc.docToken = cached.docToken;
      stats.reused++;
      stats.assigned++;
      continue;
    }

    const childTitle = pickChildTitle(svc);

    // Cache miss: adopt an existing same-title child created by a previous
    // sync (possibly another user's / another machine's) before creating.
    const existing = claimByTitle(childTitle);
    if (existing) {
      svc.docToken = existing.nodeToken;
      upsertAutoToken(auto, svc.name, {
        docToken: existing.nodeToken,
        createdAt: new Date().toISOString(),
        parentDocToken: config.parentDocToken,
      });
      dirty = true;
      stats.reused++;
      stats.assigned++;
      process.stdout.write(
        `[sync] reused existing wiki child "${childTitle}" -> ${existing.nodeToken} ` +
          `(service ${svc.name})\n`,
      );
      continue;
    }

    // No existing child: create a fresh one under the shared parent
    let child;
    try {
      child = deps.createChild(parent.spaceId, parent.nodeToken, childTitle, larkBin);
    } catch (err) {
      throw new Error(
        `auto-create child for service "${svc.name}" failed: ${
          err instanceof WikiError ? err.message : (err as Error).message
        }`,
      );
    }
    svc.docToken = child.nodeToken;
    upsertAutoToken(auto, svc.name, {
      docToken: child.nodeToken,
      createdAt: new Date().toISOString(),
      parentDocToken: config.parentDocToken,
    });
    dirty = true;
    stats.created++;
    stats.assigned++;
    process.stdout.write(
      `[sync] auto-created wiki child "${childTitle}" -> ${child.nodeToken} ` +
        `(service ${svc.name})\n`,
    );
  }

  if (dirty) saveAutoTokens(basedir, auto);
  return stats;
}

function buildTitlePool(children: WikiChild[]): Map<string, WikiChild[]> {
  const pool = new Map<string, WikiChild[]>();
  for (const c of children) {
    const k = c.title.trim().toLowerCase();
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k)!.push(c);
  }
  return pool;
}

/** Pick the title for an auto-created wiki child. */
function pickChildTitle(svc: ServiceConfig): string {
  // parentTitle is the per-service title users normally set; use it if present
  // to keep the wiki tree readable. Fall back to service.name otherwise.
  if (typeof (svc as any).parentTitle === 'string' && (svc as any).parentTitle.trim()) {
    return (svc as any).parentTitle.trim();
  }
  return svc.name;
}

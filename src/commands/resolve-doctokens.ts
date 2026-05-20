import {
  loadAutoTokens,
  saveAutoTokens,
  lookupAutoToken,
  upsertAutoToken,
} from '../auto-tokens.js';
import { resolveWikiNode, createWikiChild, WikiError } from '../lark/wiki.js';
import type { Config, ServiceConfig } from '../types.js';

/**
 * For each service whose docToken is missing, auto-create (or reuse from cache)
 * a child wiki node under the shared parentDocToken.
 *
 * Mutates `services` in-place: each service ends up with a non-empty docToken.
 *
 * Persists the auto-created token → service-name mapping in
 * `.openapi-lark/auto-tokens.json` so subsequent sync runs reuse the same
 * child node instead of creating new ones.
 *
 * Throws if a service is missing docToken AND config.parentDocToken is also
 * unset (this should be caught earlier by schema validation but we double-check).
 */
export function resolveDocTokens(
  basedir: string,
  config: Config,
  larkBin: string = 'lark-cli',
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
    parent = resolveWikiNode(config.parentDocToken, larkBin);
  } catch (err) {
    throw new Error(
      `failed to resolve parentDocToken "${config.parentDocToken}": ${(err as Error).message}`,
    );
  }

  const auto = loadAutoTokens(basedir);
  let dirty = false;

  for (const svc of needsAuto) {
    const cached = lookupAutoToken(auto, svc.name);
    if (cached && cached.parentDocToken === config.parentDocToken) {
      svc.docToken = cached.docToken;
      stats.reused++;
      stats.assigned++;
      continue;
    }

    // Create a fresh child wiki node under the shared parent
    const childTitle = pickChildTitle(svc);
    let child;
    try {
      child = createWikiChild(parent.spaceId, parent.nodeToken, childTitle, larkBin);
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

/** Pick the title for an auto-created wiki child. */
function pickChildTitle(svc: ServiceConfig): string {
  // parentTitle is the per-service title users normally set; use it if present
  // to keep the wiki tree readable. Fall back to service.name otherwise.
  if (typeof (svc as any).parentTitle === 'string' && (svc as any).parentTitle.trim()) {
    return (svc as any).parentTitle.trim();
  }
  return svc.name;
}

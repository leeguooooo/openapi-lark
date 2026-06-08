import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import { loadAndDereference, renderApi, RenderError } from '../renderer/index.js';
import { markdownToXml } from '../renderer/markdown-to-xml.js';
import { resolveOpenapiPath } from '../config/load.js';
import {
  splitByEndpoint,
  splitByTag,
  titleForEndpoint,
  titleForTag,
  type EndpointSlice,
} from '../renderer/split-by-tag.js';
import { autoGroupEndpoints } from '../renderer/auto-group.js';
import { groupHeadingWarnings } from '../renderer/heading-check.js';
import { push } from '../lark/push.js';
import {
  resolveWikiNode,
  listWikiChildren,
  createWikiChild,
  moveWikiNode,
  deleteWikiNode,
  WikiError,
  type WikiChild,
} from '../lark/wiki.js';
import {
  buildChildPool,
  popByCascade,
  remainingChildren,
  type ChildPool,
} from '../lark/child-pool.js';
import { detectMisconfiguredParent } from '../lark/parent-guard.js';
import {
  endpointIdentity,
  extractEndpointIdentity,
  getGroupNode,
  getLeafNode,
  getTagNode,
  removeNodeByToken,
  setGroupNode,
  setLeafNode,
  setTagNode,
  type NodeMapData,
} from '../node-map.js';
import {
  DEFAULT_MAX_RESOLVED_SIZE_BYTES,
  type Config,
  type ServiceConfig,
  type ServiceResult,
} from '../types.js';
import { lockTitleInMarkdown } from './sync-tree.js';
import {
  loadLock,
  saveLock,
  lookup as lockLookup,
  upsert as lockUpsert,
  remove as lockRemove,
  hashMarkdown,
  type SyncLockData,
} from '../sync-lock.js';

export interface EndpointSyncContext {
  config: Config;
  basedir: string;
  service: ServiceConfig;
  outDirRel: string;
  parallel: number;
  timeoutMs: number;
  pushBytesLimit: number;
  /** Force re-push even if hash matches. Default false. */
  force?: boolean;
  /** Shared mutable lockfile data; saved by caller after sync. */
  lock: SyncLockData;
  /** Shared mutable node-map data; saved by caller after sync. Maps
   *  spec-derived identity keys (tagId, groupKey, METHOD path) to wiki
   *  nodeTokens — survives summary / tagAlias changes that used to leave
   *  zombie wiki nodes behind. See src/node-map.ts. */
  nodeMap: NodeMapData;
  /**
   * Skip every write-side wiki call (createWikiChild, push, lockUpsert).
   * Read-side calls (resolveWikiNode, listWikiChildren) still run so the
   * caller can see what would be recycled vs. created. Local markdown is
   * still rendered + written to disk. Logs are prefixed `(would)` to make
   * the difference visible.
   */
  dryRun?: boolean;
  /** When a leaf is detected as changed, print first N lines of unified diff
   *  to stderr. Helps users figure out if a re-push is real change or
   *  generator noise (e.g. ogen field-order drift). */
  showDiff?: boolean;
}

/** A wiki node flagged by zombie detection: it lives under this project's
 *  parent, was created by a prior sync, but the current spec has no matching
 *  tag/group/endpoint for it. The only nodes auto-prune is ever allowed to
 *  touch. */
export interface ZombieNode {
  kind: 'tag' | 'group' | 'leaf';
  title: string;
  nodeToken: string;
  objToken: string;
  /** Drive object type (usually 'docx'); needed for `wiki +node-delete --obj-type`. */
  objType?: string;
  spaceId: string;
  parentTitle: string;
  endpointIdentity: string | null;
}

/**
 * Auto-prune the detected zombie nodes per the service's `prune` setting.
 * STRICTLY confined to the `zombies` list handed in — never lists or touches
 * any other node. Safety rules:
 *   - prune 'off' / unset → no-op (historical behaviour, only the warning runs).
 *   - prune 'move' without pruneSpaceId → clear error, fall back to warn-only
 *     (does NOT move/delete anything).
 *   - dry-run → print "(would) prune ..." only; no remote writes.
 *   - per-node failure (permission / network / already-gone) is logged and
 *     skipped; it never aborts the sync.
 * On success, the node's node-map + lockfile entries are removed so the next
 * sync doesn't re-flag it.
 *
 * Returns a result the caller folds into ServiceResults. Exposed (exported)
 * for unit testing with a mocked lark layer via the `deps` override.
 */
export interface PruneDeps {
  move: typeof moveWikiNode;
  remove: typeof deleteWikiNode;
}

export function pruneZombies(
  zombies: ZombieNode[],
  opts: {
    svcName: string;
    prune: 'off' | 'move' | 'delete' | undefined;
    pruneSpaceId?: string;
    larkBin: string;
    dryRun: boolean;
    nodeMap: NodeMapData;
    lock: SyncLockData;
  },
  deps: PruneDeps = { move: moveWikiNode, remove: deleteWikiNode },
): { pruned: number; failed: number } {
  const mode = opts.prune ?? 'off';
  if (mode === 'off' || zombies.length === 0) return { pruned: 0, failed: 0 };

  // Never act on dry-run-faked nodes (no real tokens to move/delete).
  const targets = zombies.filter((z) => !z.nodeToken.startsWith('dryrun-'));
  if (targets.length === 0) {
    if (opts.dryRun) {
      process.stderr.write(
        `[prune] ${opts.svcName}: dry-run produced no real zombie nodes to prune.\n`,
      );
    }
    return { pruned: 0, failed: 0 };
  }

  if (mode === 'move' && !opts.pruneSpaceId) {
    process.stderr.write(
      `[prune] ${opts.svcName}: ⚠ prune: move requires \`pruneSpaceId\` (target wiki space) ` +
        `but it is missing — NOT moving anything. Set services[].pruneSpaceId to a recycle ` +
        `space, or use prune: delete. Falling back to warn-only.\n`,
    );
    return { pruned: 0, failed: 0 };
  }

  process.stderr.write(
    `[prune] ${opts.svcName}: ${opts.dryRun ? '(dry-run) ' : ''}auto-prune ${mode} ` +
      `on ${targets.length} zombie node(s)` +
      (mode === 'move' ? ` → space ${opts.pruneSpaceId}` : '') +
      `\n`,
  );

  let pruned = 0;
  let failed = 0;
  for (const z of targets) {
    const where =
      mode === 'move' ? `→ space ${opts.pruneSpaceId}` : `(obj-type ${z.objType ?? 'docx'})`;
    if (opts.dryRun) {
      process.stderr.write(
        `[prune] ${opts.svcName}: (would) ${mode} "${z.title}" nodeToken=${z.nodeToken} ${where}\n`,
      );
      continue;
    }
    try {
      if (mode === 'move') {
        deps.move(z.nodeToken, opts.pruneSpaceId!, z.spaceId, opts.larkBin);
      } else {
        deps.remove(z.nodeToken, z.spaceId, opts.larkBin);
      }
      // Drop the now-gone node from our maps so it isn't re-flagged next sync.
      removeNodeByToken(opts.nodeMap, opts.svcName, z.nodeToken);
      lockRemove(opts.lock, opts.svcName, z.objToken);
      pruned++;
      process.stderr.write(
        `[prune] ${opts.svcName}: ${mode === 'move' ? 'moved' : 'deleted'} "${z.title}" ` +
          `nodeToken=${z.nodeToken} ${where}\n`,
      );
    } catch (err) {
      failed++;
      process.stderr.write(
        `[prune] ${opts.svcName}: ✗ failed to ${mode} "${z.title}" nodeToken=${z.nodeToken}: ` +
          `${(err as Error).message.split('\n')[0]} (skipped, sync continues)\n`,
      );
    }
  }
  process.stderr.write(
    `[prune] ${opts.svcName}: ${opts.dryRun ? '(dry-run) ' : ''}pruned ${pruned} / failed ${failed}\n`,
  );
  return { pruned, failed };
}

/**
 * Build a fake WikiChild for dry-run mode. The tokens carry a `dryrun-` prefix
 * so they're identifiable in logs and impossible to confuse with real lark
 * tokens (real tokens never start with `dryrun-`).
 */
/**
 * Tiny line-level diff preview for `--show-diff`. Not a full Myers diff —
 * we mark each line as added (only in `b`), removed (only in `a`), or
 * unchanged (in both, by line content). Adequate for spotting generator
 * noise like reordered table rows or shifted whitespace; for surgical diff
 * users have the file on disk and can run `git diff` themselves.
 *
 * Output mirrors unified-diff convention: `+ added`, `- removed`.
 * Truncated to `maxLines` non-context lines to keep stderr readable.
 */
export function unifiedDiffPreview(a: string, b: string, maxLines: number): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  const out: string[] = [];
  // First pass: anything in b that's not in a → '+'
  // Second pass: anything in a that's not in b → '-'
  // (Misses moves/shifts; doesn't claim to.)
  for (const line of bLines) {
    if (!aSet.has(line) && out.length < maxLines) out.push(`+ ${line}`);
  }
  for (const line of aLines) {
    if (!bSet.has(line) && out.length < maxLines) out.push(`- ${line}`);
  }
  if (out.length === 0) {
    return '  (no line-level diff — likely whitespace-only)';
  }
  return out.map((l) => '    ' + l).join('\n');
}

function fakeDryRunChild(title: string, parentNodeToken: string): WikiChild {
  const slug = title
    .replace(/[^a-zA-Z0-9一-鿿]+/g, '_')
    .slice(0, 24)
    .toLowerCase() || 'untitled';
  const suffix = parentNodeToken.slice(-6) || 'root';
  return {
    nodeToken: `dryrun-node-${slug}-${suffix}`,
    objToken: `dryrun-doc-${slug}-${suffix}`,
    title,
    objType: 'docx',
    hasChild: false,
  };
}

/**
 * Three-level wiki tree:
 *   parent (docToken)
 *     ├── intermediate "tag" node (one per tag)
 *     │     ├── leaf (one per single endpoint = single path+method)
 *     │     ├── leaf
 *     │     └── ...
 *     ├── tag 2
 *     │     └── ...
 *     └── ...
 *
 * Each leaf wiki node hosts one endpoint's documentation only.
 * Tag intermediate node hosts a short index (list of endpoints under it).
 */
export async function runEndpointSync(ctx: EndpointSyncContext): Promise<ServiceResult[]> {
  const results: ServiceResult[] = [];
  const svc = ctx.service;
  const larkBin = ctx.config.larkBin ?? 'lark-cli';

  if (ctx.dryRun) {
    process.stdout.write(
      `[sync] ${svc.name}: ⚠ DRY-RUN — no wiki writes (createWikiChild, docs +update); local renders only.\n` +
        `        ℹ dry-run still READS wiki (resolveWikiNode, listWikiChildren) for recycling pool display.\n` +
        `        For zero remote calls, use \`openapi-lark render ${svc.name}\` instead.\n`,
    );
  }

  // Resolve wiki parent. In dry-run we tolerate failure (e.g. user is still
  // waiting for `wiki:node:read` scope approval) and fall back to a fake parent
  // so the render preview still works. Real sync still fails fast.
  let parent: ReturnType<typeof resolveWikiNode>;
  try {
    parent = resolveWikiNode(svc.docToken!, larkBin);
    process.stdout.write(
      `[sync] ${svc.name}: wiki parent resolved (space=${parent.spaceId}, title="${parent.title}")\n`,
    );
  } catch (err) {
    if (!ctx.dryRun) {
      return [
        {
          service: svc.name,
          status: 'failed',
          durationMs: 0,
          reason: err instanceof WikiError ? err.message : (err as Error).message,
        },
      ];
    }
    process.stderr.write(
      `[sync] ${svc.name}: ⚠ wiki parent unreachable in dry-run — falling back to local-only preview.\n` +
        `        (cause: ${(err as Error).message.split('\n')[0]})\n` +
        `        Renders will be written but recycling pool can't be shown without wiki:node:read.\n`,
    );
    parent = {
      spaceId: 'dryrun-space',
      nodeToken: 'dryrun-root',
      objToken: `dryrun-parent-${(svc.docToken ?? 'unknown').slice(-6)}`,
      objType: 'docx',
      title: svc.parentTitle || svc.name,
      parentNodeToken: '',
    };
  }

  const openapiPath = resolveOpenapiPath(ctx.basedir, svc.openapi);
  let api: unknown;
  try {
    ({ api } = await loadAndDereference(
      openapiPath,
      ctx.config.maxResolvedSizeBytes ?? DEFAULT_MAX_RESOLVED_SIZE_BYTES,
      {
        headers: svc.openapiHeaders,
        snapshotAbsPath: svc.openapiSnapshot
          ? resolve(ctx.basedir, svc.openapiSnapshot)
          : undefined,
      },
    ));
  } catch (err) {
    return [
      {
        service: svc.name,
        status: 'failed',
        durationMs: 0,
        reason: err instanceof RenderError ? err.message : (err as Error).message,
      },
    ];
  }

  const tagSplit = splitByTag(api);
  const endpoints = splitByEndpoint(api);

  // Tag filtering
  const allTags = Object.keys(tagSplit.byTag);
  const wantedTags = svc.includeTags?.length ? svc.includeTags : allTags;
  const tagIds = wantedTags.filter(
    (t) => allTags.includes(t) && !(svc.excludeTags ?? []).includes(t),
  );
  const totalEndpoints = endpoints.filter((e) => tagIds.includes(e.tagId)).length;
  process.stdout.write(
    `[sync] ${svc.name}: ${tagIds.length} tag(s), ${totalEndpoints} endpoint(s) total\n`,
  );

  mkdirSync(resolve(ctx.basedir, ctx.outDirRel), { recursive: true });

  // Step A: push overview to parent docx
  // Title precedence: svc.parentTitle (explicit override) > existing parent title > svc.name
  const parentLockTitle = svc.parentTitle || parent.title || svc.name;
  results.push(
    await renderAndPush({
      ctx,
      label: `${svc.name} :: overview`,
      api: tagSplit.overview,
      docToken: parent.objToken,
      outRel: `${ctx.outDirRel}/_overview.md`,
      titleForLock: parentLockTitle,
    }),
  );

  // Step B: list existing tag children once.
  // If parent was faked (dry-run + no wiki:node:read), skip the call entirely
  // — there's nothing to list. Otherwise on real failure: bail in real sync,
  // degrade to empty pool in dry-run.
  let tagChildren: WikiChild[];
  if (parent.nodeToken.startsWith('dryrun-')) {
    tagChildren = [];
  } else {
    try {
      tagChildren = listWikiChildren(parent.spaceId, parent.nodeToken, larkBin);
    } catch (err) {
      if (!ctx.dryRun) {
        results.push({
          service: svc.name,
          status: 'failed',
          durationMs: 0,
          reason: `listWikiChildren(tag-level) failed: ${(err as Error).message}`,
        });
        return results;
      }
      process.stderr.write(
        `[sync] ${svc.name}: ⚠ list tag children failed in dry-run — assuming empty pool\n`,
      );
      tagChildren = [];
    }
  }

  // Tag-level recovery pool: indexed by nodeToken / endpoint-identity / title.
  // Matching cascade per tag: node-map[tagId] → byTitle. Identity-by-title
  // doesn't apply to tag nodes (their title is plain language, not METHOD path).
  const tagPool = buildChildPool(tagChildren);

  // Guard: warn (don't block) if docToken looks like it points at a shared /
  // space-root node rather than this project's dedicated parent. Skipped for
  // faked dry-run parents (tagChildren is empty there anyway).
  const expectedTagTitles = tagIds.map((t) => titleForTag(t, api, svc.tagAliases));
  const misconfig = detectMisconfiguredParent({
    children: tagChildren,
    expectedTagTitles,
  });
  if (misconfig) {
    const samples = misconfig.foreignTitles.map((t) => `"${t}"`).join(', ');
    process.stderr.write(
      `\n[sync] ${svc.name}: ⚠ docToken may point at a SHARED / root wiki node, not this project's parent.\n` +
        `        ${misconfig.foreignCount}/${misconfig.totalCount} existing children under ` +
        `"${parent.title}" don't match this spec's tags or look like API docs ` +
        `(${(misconfig.foreignFraction * 100).toFixed(0)}% foreign).\n` +
        `        e.g. ${samples}\n` +
        `        If that's wrong, sync will scatter this project's nodes there AND the ` +
        `zombie report below will falsely flag unrelated docs.\n` +
        `        → Verify services[].docToken in .openapi-lark.yaml points at a node ` +
        `dedicated to "${svc.name}". (This is a warning; sync continues.)\n\n`,
    );
  }

  // Collect zombies for end-of-sync report. Zombies = wiki nodes that were
  // listed under the parent at the start of sync but never claimed by any
  // tag/group/leaf during this run. They're documents for endpoints / tags /
  // groups that no longer exist in the spec (or whose identity drifted in a
  // way our cascade couldn't recover).
  const zombieReport: ZombieNode[] = [];

  // Sequential per-tag (parallel per-endpoint inside)
  for (const tagId of tagIds) {
    const tagTitle = titleForTag(tagId, api, svc.tagAliases);
    const knownTagNode = getTagNode(ctx.nodeMap, svc.name, tagId);
    let tagNode = popByCascade(tagPool, {
      nodeToken: knownTagNode,
      title: tagTitle,
    });
    if (!tagNode) {
      if (ctx.dryRun) {
        tagNode = fakeDryRunChild(tagTitle, parent.nodeToken);
        process.stdout.write(
          `[sync] ${svc.name}: (would) create tag node "${tagTitle}"\n`,
        );
      } else {
        try {
          tagNode = createWikiChild(parent.spaceId, parent.nodeToken, tagTitle, larkBin);
          process.stdout.write(`[sync] ${svc.name}: created tag node "${tagTitle}"\n`);
        } catch (err) {
          results.push({
            service: `${svc.name} :: ${tagId}`,
            status: 'failed',
            durationMs: 0,
            reason: `createWikiChild(tag) failed: ${(err as Error).message}`,
          });
          continue;
        }
      }
    } else {
      process.stdout.write(
        `[sync] ${svc.name}: ${ctx.dryRun ? '(would) recycle' : 'recycled'} tag node ${tagNode.nodeToken} (was "${tagNode.title}") -> "${tagTitle}"\n`,
      );
    }
    // Persist tagId → nodeToken so the next sync can recycle even if title drifts.
    if (!ctx.dryRun && !tagNode.nodeToken.startsWith('dryrun-')) {
      setTagNode(ctx.nodeMap, svc.name, tagId, tagNode.nodeToken);
    }

    // Render tag-level index. In endpoint mode this is intentionally SHORT —
    // just a heading + bullet list of child endpoints. Lark wiki's sidebar
    // already lists the children; the doc itself should not duplicate the full
    // per-tag content (that's what blew up the push to >1MB for 语音房/管理端).
    const tagSlices = endpoints.filter((e) => e.tagId === tagId);
    const indexMd = buildTagIndexMarkdown(tagTitle, tagSlices);
    results.push(
      await pushPrebuilt({
        ctx,
        label: `${svc.name} :: ${tagId} :: index`,
        markdown: indexMd,
        docToken: tagNode.objToken,
        outRel: `${ctx.outDirRel}/${safeFilename(tagId)}/_index.md`,
        titleForLock: tagTitle,
      }),
    );

    // List existing endpoint leaves under this tag.
    // If we faked the tag node in dry-run, there are no real children to list.
    let leafChildren: WikiChild[];
    if (tagNode.nodeToken.startsWith('dryrun-')) {
      leafChildren = [];
    } else {
      try {
        leafChildren = listWikiChildren(parent.spaceId, tagNode.nodeToken, larkBin);
      } catch (err) {
        results.push({
          service: `${svc.name} :: ${tagId}`,
          status: 'failed',
          durationMs: 0,
          reason: `listWikiChildren(leaf-level) failed: ${(err as Error).message}`,
        });
        continue;
      }
    }
    const leafPool = buildChildPool(leafChildren);

    // Endpoints under this tag
    const slices = endpoints.filter((e) => e.tagId === tagId);
    // Auto-decide: 4-level (path-prefix sub-groups) when worthwhile, else flat
    const grouping = autoGroupEndpoints(slices);
    const groupKeys = Object.keys(grouping.groups);
    if (groupKeys.length > 0) {
      process.stdout.write(
        `[sync] ${svc.name}: ${tagId} has ${slices.length} endpoint(s), ` +
          `auto-grouping into ${groupKeys.length} sub-group(s) + ` +
          `${grouping.singletons.length} singleton(s)\n`,
      );
    } else {
      process.stdout.write(
        `[sync] ${svc.name}: ${tagId} has ${slices.length} endpoint(s) (flat)\n`,
      );
    }

    const limit = pLimit(ctx.parallel);
    const leafResults: ServiceResult[] = [];

    // 1) Singletons: push directly under the tag node
    for (const slice of grouping.singletons) {
      const r = await limit(() =>
        pushEndpointLeaf({
          ctx,
          svcName: svc.name,
          tagId,
          parentSpaceId: parent.spaceId,
          parentNodeToken: tagNode!.nodeToken,
          pool: leafPool,
          slice,
          larkBin,
          outDirRelTag: `${ctx.outDirRel}/${safeFilename(tagId)}`,
        }),
      );
      leafResults.push(r);
    }

    // 2) Multi-endpoint groups: create intermediate group node, then leaves
    for (const groupKey of groupKeys) {
      const groupTitle = grouping.groupTitles[groupKey] ?? groupKey;
      // Find or create the group intermediate node under the tag.
      // Identity-by-title doesn't apply (group titles are path-prefix
      // derived plain language), so cascade is: node-map → byTitle.
      const knownGroupNode = getGroupNode(ctx.nodeMap, svc.name, tagId, groupKey);
      let groupNode = popByCascade(leafPool, {
        nodeToken: knownGroupNode,
        title: groupTitle,
      });
      if (!groupNode) {
        if (ctx.dryRun) {
          groupNode = fakeDryRunChild(groupTitle, tagNode!.nodeToken);
          process.stdout.write(
            `[sync] ${svc.name}: (would) create group node "${groupTitle}" (under ${tagId})\n`,
          );
        } else {
          try {
            groupNode = createWikiChild(
              parent.spaceId,
              tagNode!.nodeToken,
              groupTitle,
              larkBin,
            );
            process.stdout.write(
              `[sync] ${svc.name}: created group node "${groupTitle}" (under ${tagId})\n`,
            );
          } catch (err) {
            leafResults.push({
              service: `${svc.name} :: ${tagId} :: ${groupTitle}`,
              status: 'failed',
              durationMs: 0,
              reason: `createWikiChild(group) failed: ${(err as Error).message}`,
            });
            continue;
          }
        }
      } else {
        process.stdout.write(
          `[sync] ${svc.name}: ${ctx.dryRun ? '(would) recycle' : 'recycled'} group node ${groupNode.nodeToken} (was "${groupNode.title}") -> "${groupTitle}"\n`,
        );
      }
      // Persist (tagId, groupKey) → nodeToken for next sync's recycling.
      if (!ctx.dryRun && !groupNode.nodeToken.startsWith('dryrun-')) {
        setGroupNode(ctx.nodeMap, svc.name, tagId, groupKey, groupNode.nodeToken);
      }
      // List existing endpoint leaves under THIS group node.
      // If we faked the group node in dry-run, there are no real children to list.
      let groupLeafChildren: WikiChild[];
      if (groupNode.nodeToken.startsWith('dryrun-')) {
        groupLeafChildren = [];
      } else {
        try {
          groupLeafChildren = listWikiChildren(parent.spaceId, groupNode.nodeToken, larkBin);
        } catch (err) {
          leafResults.push({
            service: `${svc.name} :: ${tagId} :: ${groupTitle}`,
            status: 'failed',
            durationMs: 0,
            reason: `listWikiChildren(group-level) failed: ${(err as Error).message}`,
          });
          continue;
        }
      }
      const groupLeafPool = buildChildPool(groupLeafChildren);
      // Push the group intermediate doc itself (just a TOC)
      const groupSlices = grouping.groups[groupKey];
      const indexMd = buildTagIndexMarkdown(groupTitle, groupSlices);
      leafResults.push(
        await pushPrebuilt({
          ctx,
          label: `${svc.name} :: ${tagId} :: ${groupTitle} :: index`,
          markdown: indexMd,
          docToken: groupNode.objToken,
          outRel: `${ctx.outDirRel}/${safeFilename(tagId)}/${safeFilename(groupTitle)}/_index.md`,
          titleForLock: groupTitle,
        }),
      );
      // Push the group's endpoint leaves
      for (const slice of groupSlices) {
        const r = await limit(() =>
          pushEndpointLeaf({
            ctx,
            svcName: svc.name,
            tagId,
            groupKey,
            parentSpaceId: parent.spaceId,
            parentNodeToken: groupNode!.nodeToken,
            pool: groupLeafPool,
            slice,
            larkBin,
            outDirRelTag: `${ctx.outDirRel}/${safeFilename(tagId)}/${safeFilename(groupTitle)}`,
            labelPrefixExtra: ` :: ${groupTitle}`,
          }),
        );
        leafResults.push(r);
      }
      // Anything left in groupLeafPool was not claimed by any current endpoint
      // under this group — record as zombie.
      for (const c of remainingChildren(groupLeafPool)) {
        zombieReport.push({
          kind: extractEndpointIdentity(c.title) ? 'leaf' : 'group',
          title: c.title,
          nodeToken: c.nodeToken,
          objToken: c.objToken,
          objType: c.objType,
          spaceId: parent.spaceId,
          parentTitle: groupTitle,
          endpointIdentity: extractEndpointIdentity(c.title),
        });
      }
    }
    // Anything left under this tag (singleton-level leafPool) is a zombie too.
    for (const c of remainingChildren(leafPool)) {
      zombieReport.push({
        kind: extractEndpointIdentity(c.title) ? 'leaf' : 'group',
        title: c.title,
        nodeToken: c.nodeToken,
        objToken: c.objToken,
        objType: c.objType,
        spaceId: parent.spaceId,
        parentTitle: tagTitle,
        endpointIdentity: extractEndpointIdentity(c.title),
      });
    }

    results.push(...leafResults);
  }

  // Any tags left unclaimed in the top-level pool are zombies too — typically
  // tags that were removed from the spec entirely. Includes the case where
  // includeTags/excludeTags narrowed scope this run; users running a scoped
  // sync should treat these as expected, not zombies. We still report them
  // so the user can confirm.
  for (const c of remainingChildren(tagPool)) {
    zombieReport.push({
      kind: 'tag',
      title: c.title,
      nodeToken: c.nodeToken,
      objToken: c.objToken,
      objType: c.objType,
      spaceId: parent.spaceId,
      parentTitle: parent.title,
      endpointIdentity: extractEndpointIdentity(c.title),
    });
  }

  if (zombieReport.length > 0) {
    process.stderr.write(
      `\n[sync] ${svc.name}: ⚠ ${zombieReport.length} zombie wiki node(s) detected ` +
        `(leftover from prior syncs, no longer in current spec):\n`,
    );
    for (const z of zombieReport) {
      const idLabel = z.endpointIdentity ? ` [${z.endpointIdentity}]` : '';
      const url = z.nodeToken.startsWith('dryrun-')
        ? '(dry-run, no URL)'
        : `https://feishu.cn/wiki/${z.nodeToken}`;
      process.stderr.write(
        `  · ${z.kind}: "${z.title}"${idLabel} (under "${z.parentTitle}")\n` +
          `      nodeToken=${z.nodeToken} objToken=${z.objToken}\n` +
          `      ${url}\n`,
      );
    }
    const pruneMode = svc.prune ?? 'off';
    if (pruneMode === 'off') {
      process.stderr.write(
        `  ⓘ prune is off — openapi-lark won't touch these. Review and remove manually, ` +
          `or set services[].prune to 'move' (recommended) / 'delete' to auto-prune. ` +
          `See README §Auto-prune.\n\n`,
      );
    } else {
      process.stderr.write(`\n`);
    }
  }

  // Opt-in auto-prune. No-op unless services[].prune is 'move'/'delete'.
  // Strictly limited to the zombieReport list above; honors dry-run.
  const pruneResult = pruneZombies(zombieReport, {
    svcName: svc.name,
    prune: svc.prune,
    pruneSpaceId: svc.pruneSpaceId,
    larkBin,
    dryRun: !!ctx.dryRun,
    nodeMap: ctx.nodeMap,
    lock: ctx.lock,
  });
  if (pruneResult.pruned > 0 || pruneResult.failed > 0) {
    results.push({
      service: `${svc.name} :: prune`,
      status: pruneResult.failed > 0 ? 'warning' : 'ok',
      durationMs: 0,
      reason: `prune ${svc.prune}: ${pruneResult.pruned} pruned / ${pruneResult.failed} failed`,
    });
  }

  return results;
}

/** Push a single endpoint leaf — find/create wiki child + renderAndPush. */
async function pushEndpointLeaf(args: {
  ctx: EndpointSyncContext;
  svcName: string;
  tagId: string;
  /** If the leaf lives under an auto-created group node, this is the
   *  group key (path-prefix derived). Used only for diagnostic logging;
   *  leaf identity in node-map is METHOD+path regardless of group. */
  groupKey?: string;
  parentSpaceId: string;
  parentNodeToken: string;
  pool: ChildPool;
  slice: EndpointSlice;
  larkBin: string;
  outDirRelTag: string;
  labelPrefixExtra?: string;
}): Promise<ServiceResult> {
  const { ctx, svcName, tagId, parentSpaceId, parentNodeToken, pool, slice, larkBin, outDirRelTag, labelPrefixExtra } = args;
  const leafTitle = titleForEndpoint(slice);
  const identity = endpointIdentity(slice.method, slice.path);
  // Cascade: node-map → identity-extracted-from-title → legacy full-title.
  // This survives a summary change ("预测" → "创建预测（下注）") because the
  // identity (POST /api/v1/predicts) stays the same; the old wiki node is
  // recycled and renamed via --new-title on push.
  const knownLeafNode = getLeafNode(ctx.nodeMap, svcName, identity);
  let leaf = popByCascade(pool, {
    nodeToken: knownLeafNode,
    endpointIdentity: identity,
    title: leafTitle,
  });
  if (!leaf) {
    if (ctx.dryRun) {
      leaf = fakeDryRunChild(leafTitle, parentNodeToken);
    } else {
      try {
        leaf = createWikiChild(parentSpaceId, parentNodeToken, leafTitle, larkBin);
      } catch (err) {
        return {
          service: `${svcName} :: ${tagId}${labelPrefixExtra ?? ''} :: ${leafTitle}`,
          status: 'failed' as const,
          durationMs: 0,
          reason: `createWikiChild(leaf) failed: ${(err as Error).message}`,
        };
      }
    }
  } else if (leaf.title !== leafTitle) {
    // We recycled an existing node whose title drifted (summary change).
    // renderAndPush will pass `newTitle: leafTitle` to lark-cli below.
    process.stdout.write(
      `[sync] ${svcName}: ${ctx.dryRun ? '(would) rename' : 'renaming'} leaf node ${leaf.nodeToken} ` +
        `(was "${leaf.title}") -> "${leafTitle}" [identity=${identity}]\n`,
    );
  }
  // Persist METHOD+path → nodeToken for future syncs. Skip dry-run/faked nodes.
  if (!ctx.dryRun && !leaf.nodeToken.startsWith('dryrun-')) {
    setLeafNode(ctx.nodeMap, svcName, identity, leaf.nodeToken);
  }
  return renderAndPush({
    ctx,
    label: `${svcName} :: ${tagId}${labelPrefixExtra ?? ''} :: ${leafTitle}`,
    api: slice.api,
    docToken: leaf.objToken,
    outRel: `${outDirRelTag}/${safeFilename(leafTitle)}.md`,
    titleForLock: leafTitle,
    singleOperationSummary: slice.summary,
  });
}

// Pool helpers moved to src/lark/child-pool.ts (buildChildPool, popByCascade,
// popByTitle, popByEndpointIdentity, popByNodeToken, remainingChildren).
// They live there so identity-based matching gets full unit-test coverage
// independent of the sync orchestration.

interface RAPArgs {
  ctx: EndpointSyncContext;
  label: string;
  api: unknown;
  docToken: string;
  outRel: string;
  titleForLock: string;
  /** If this api contains exactly one operation, pass its summary here to
   *  enable the redundant-intro collapse in post-process. */
  singleOperationSummary?: string;
}

async function renderAndPush(args: RAPArgs): Promise<ServiceResult> {
  const { ctx, label, api, docToken, outRel, titleForLock, singleOperationSummary } = args;
  const started = Date.now();
  let markdown: string;
  let warnings;
  try {
    const out = await renderApi(api, 'widdershins', singleOperationSummary);
    markdown = lockTitleInMarkdown(out.markdown, titleForLock);
    warnings = out.headingWarnings;
  } catch (err) {
    return {
      service: label,
      status: 'failed',
      durationMs: Date.now() - started,
      reason: `render failed: ${(err as Error).message}`,
    };
  }

  const grouped = groupHeadingWarnings(warnings);
  for (const g of grouped) {
    process.stderr.write(
      `[sync] ${label}: heading jump H${g.from} → H${g.to} "${g.pattern}" ×${g.count}\n`,
    );
  }

  const absPath = resolve(ctx.basedir, outRel);
  mkdirSync(resolve(absPath, '..'), { recursive: true });
  // For --show-diff: capture the previously-written markdown BEFORE we
  // overwrite it. The render cache lives in .openapi-lark/<svc>/ which
  // persists across runs (gitignored). If file is missing this is a first
  // sync for the leaf — nothing to diff against.
  const priorRendered =
    ctx.showDiff && existsSync(absPath) ? readFileSync(absPath, 'utf8') : null;
  writeFileSync(absPath, markdown, 'utf8');

  // Endpoint mode: also emit a Lark DocxXML variant with four tasteful rich
  // blocks (顶部速览 callout / 表头底色 / 状态码颜色 / 示例 caption). Any failure
  // here falls back to the markdown push so sync never breaks.
  let xmlOutRel: string | null = null;
  let xmlContent: string | null = null;
  try {
    xmlContent = markdownToXml(markdown, api, titleForLock);
    if (xmlContent && xmlContent.trim()) {
      const xmlRel = outRel.replace(/\.md$/, '.xml');
      // Guard against an unexpected non-.md outRel (would otherwise overwrite md).
      xmlOutRel = xmlRel !== outRel ? xmlRel : `${outRel}.xml`;
      writeFileSync(resolve(ctx.basedir, xmlOutRel), xmlContent, 'utf8');
    } else {
      xmlContent = null;
    }
  } catch (err) {
    process.stderr.write(
      `[sync] ${label}: XML 生成失败，回退 markdown 推送：${(err as Error).message}\n`,
    );
    xmlContent = null;
    xmlOutRel = null;
  }

  // Hash check: skip push if content unchanged from last successful sync.
  // Uses normalized hash (CRLF / trailing-whitespace insensitive) to dampen
  // cosmetic drift from upstream OpenAPI generators.
  const hash = hashMarkdown(markdown);
  const prior = lockLookup(ctx.lock, ctx.service.name, docToken);
  if (!ctx.force && prior && prior.sha256 === hash && prior.title === titleForLock) {
    return {
      service: label,
      status: 'skipped',
      durationMs: Date.now() - started,
      reason: `unchanged (sha256 match)`,
    };
  }

  if (ctx.showDiff && priorRendered !== null && priorRendered !== markdown) {
    const diff = unifiedDiffPreview(priorRendered, markdown, 20);
    process.stderr.write(`[sync] ${label}: diff (truncated to 20 lines):\n${diff}\n`);
  }

  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > ctx.pushBytesLimit) {
    return {
      service: label,
      status: 'failed',
      durationMs: Date.now() - started,
      reason:
        `rendered ${(bytes / 1024).toFixed(0)} KB exceeds maxPushBytes ` +
        `(${(ctx.pushBytesLimit / 1024).toFixed(0)} KB). Local md: ${absPath}`,
    };
  }
  if (ctx.dryRun) {
    // Skip push + lockUpsert. Local md (+ xml) already written above.
    const fmtNote = xmlOutRel ? ` (XML: ${resolve(ctx.basedir, xmlOutRel)})` : ' (markdown)';
    return {
      service: label,
      status: 'ok',
      durationMs: Date.now() - started,
      reason: `(dry-run) wrote ${absPath}${fmtNote}; would push ${(bytes / 1024).toFixed(1)} KB`,
    };
  }
  // Prefer the rich XML push; fall back to markdown if XML wasn't produced.
  let pushed = push({
    docToken,
    mdPath: xmlOutRel ?? outRel,
    docFormat: xmlOutRel ? 'xml' : 'markdown',
    cwd: ctx.basedir,
    larkBin: ctx.config.larkBin,
    timeoutMs: ctx.timeoutMs,
    // Always lock the wiki node + docx title to the spec-derived value.
    // Without --new-title, lark-cli's `--command overwrite` picks an H1 from
    // the body as the title; recycled nodes whose old title drifted would
    // keep the stale title in the wiki sidebar.
    newTitle: titleForLock,
  });
  // Robust fallback: if the XML push failed (e.g. lark-cli rejected a block),
  // retry once with the plain markdown so sync never breaks on a format edge case.
  if (!pushed.ok && xmlOutRel) {
    process.stderr.write(
      `[sync] ${label}: XML 推送失败（${pushed.reason}），回退 markdown 重试\n`,
    );
    pushed = push({
      docToken,
      mdPath: outRel,
      docFormat: 'markdown',
      cwd: ctx.basedir,
      larkBin: ctx.config.larkBin,
      timeoutMs: ctx.timeoutMs,
      newTitle: titleForLock,
    });
  }
  if (pushed.ok) {
    // Record successful push in lockfile
    lockUpsert(ctx.lock, ctx.service.name, docToken, {
      sha256: hash,
      title: titleForLock,
      syncedAt: new Date().toISOString(),
    });
    return {
      service: label,
      status: pushed.url ? 'ok' : 'warning',
      docUrl: pushed.url ?? undefined,
      durationMs: Date.now() - started,
    };
  }
  return {
    service: label,
    status: 'failed',
    durationMs: Date.now() - started,
    reason: `${pushed.reason}: ${pushed.message}`,
  };
}

function safeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._\-一-鿿]+/g, '_').slice(0, 80);
}

function buildTagIndexMarkdown(
  tagTitle: string,
  slices: Array<{ method: string; path: string; summary?: string }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${tagTitle}`, '');
  lines.push(`本节包含 **${slices.length}** 个接口。点击左侧 wiki 树展开查看：`, '');
  for (const s of slices) {
    const titleText = s.summary ? `${s.summary} — \`${s.method} ${s.path}\`` : `\`${s.method} ${s.path}\``;
    lines.push(`- ${titleText}`);
  }
  return lines.join('\n') + '\n';
}

interface PushPrebuiltArgs {
  ctx: EndpointSyncContext;
  label: string;
  markdown: string;
  docToken: string;
  outRel: string;
  titleForLock: string;
}

async function pushPrebuilt(args: PushPrebuiltArgs): Promise<ServiceResult> {
  const { ctx, label, markdown: rawMd, docToken, outRel, titleForLock } = args;
  const started = Date.now();
  const markdown = lockTitleInMarkdown(rawMd, titleForLock);

  const absPath = resolve(ctx.basedir, outRel);
  mkdirSync(resolve(absPath, '..'), { recursive: true });
  const priorRendered =
    ctx.showDiff && existsSync(absPath) ? readFileSync(absPath, 'utf8') : null;
  writeFileSync(absPath, markdown, 'utf8');

  // Hash check: skip push if content unchanged
  const hash = hashMarkdown(markdown);
  const prior = lockLookup(ctx.lock, ctx.service.name, docToken);
  if (!ctx.force && prior && prior.sha256 === hash && prior.title === titleForLock) {
    return {
      service: label,
      status: 'skipped',
      durationMs: Date.now() - started,
      reason: `unchanged (sha256 match)`,
    };
  }
  if (ctx.showDiff && priorRendered !== null && priorRendered !== markdown) {
    const diff = unifiedDiffPreview(priorRendered, markdown, 20);
    process.stderr.write(`[sync] ${label}: diff (truncated to 20 lines):\n${diff}\n`);
  }

  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > ctx.pushBytesLimit) {
    return {
      service: label,
      status: 'failed',
      durationMs: Date.now() - started,
      reason: `rendered ${(bytes / 1024).toFixed(0)} KB exceeds maxPushBytes`,
    };
  }
  if (ctx.dryRun) {
    return {
      service: label,
      status: 'ok',
      durationMs: Date.now() - started,
      reason: `(dry-run) wrote ${absPath}; would push ${(bytes / 1024).toFixed(1)} KB`,
    };
  }
  const pushed = push({
    docToken,
    mdPath: outRel,
    cwd: ctx.basedir,
    larkBin: ctx.config.larkBin,
    timeoutMs: ctx.timeoutMs,
    // Always lock the wiki node + docx title to the spec-derived value.
    // Without --new-title, lark-cli's `--command overwrite` picks an H1 from
    // the markdown body as the title; recycled nodes whose old title drifted
    // would keep the stale title in the wiki sidebar.
    newTitle: titleForLock,
  });
  if (pushed.ok) {
    lockUpsert(ctx.lock, ctx.service.name, docToken, {
      sha256: hash,
      title: titleForLock,
      syncedAt: new Date().toISOString(),
    });
    return {
      service: label,
      status: pushed.url ? 'ok' : 'warning',
      docUrl: pushed.url ?? undefined,
      durationMs: Date.now() - started,
    };
  }
  return {
    service: label,
    status: 'failed',
    durationMs: Date.now() - started,
    reason: `${pushed.reason}: ${pushed.message}`,
  };
}

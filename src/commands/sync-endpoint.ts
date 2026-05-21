import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import { loadAndDereference, renderApi, RenderError } from '../renderer/index.js';
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
  WikiError,
  type WikiChild,
} from '../lark/wiki.js';
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
  sha256,
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
  /**
   * Skip every write-side wiki call (createWikiChild, push, lockUpsert).
   * Read-side calls (resolveWikiNode, listWikiChildren) still run so the
   * caller can see what would be recycled vs. created. Local markdown is
   * still rendered + written to disk. Logs are prefixed `(would)` to make
   * the difference visible.
   */
  dryRun?: boolean;
}

/**
 * Build a fake WikiChild for dry-run mode. The tokens carry a `dryrun-` prefix
 * so they're identifiable in logs and impossible to confuse with real lark
 * tokens (real tokens never start with `dryrun-`).
 */
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

  let parent: ReturnType<typeof resolveWikiNode>;
  try {
    parent = resolveWikiNode(svc.docToken!, larkBin);
  } catch (err) {
    return [
      {
        service: svc.name,
        status: 'failed',
        durationMs: 0,
        reason: err instanceof WikiError ? err.message : (err as Error).message,
      },
    ];
  }
  if (ctx.dryRun) {
    process.stdout.write(
      `[sync] ${svc.name}: ⚠ DRY-RUN — wiki nodes will NOT be created/updated; local renders only\n`,
    );
  }
  process.stdout.write(
    `[sync] ${svc.name}: wiki parent resolved (space=${parent.spaceId}, title="${parent.title}")\n`,
  );

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

  // Step B: list existing tag children once
  let tagChildren: WikiChild[];
  try {
    tagChildren = listWikiChildren(parent.spaceId, parent.nodeToken, larkBin);
  } catch (err) {
    results.push({
      service: svc.name,
      status: 'failed',
      durationMs: 0,
      reason: `listWikiChildren(tag-level) failed: ${(err as Error).message}`,
    });
    return results;
  }

  // Tag-level recovery pool: prefer exact title match, then fall back to
  // Untitled/Authentication zombies (created by earlier failed sync attempts).
  const tagPool = poolByTitle(tagChildren);

  // Sequential per-tag (parallel per-endpoint inside)
  for (const tagId of tagIds) {
    const tagTitle = titleForTag(tagId, api, svc.tagAliases);
    let tagNode = popFromPool(tagPool, tagTitle);
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
    const leafPool = poolByTitle(leafChildren);

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
      // Find or create the group intermediate node under the tag
      let groupNode = popFromPool(leafPool, groupTitle);
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
      const groupLeafPool = poolByTitle(groupLeafChildren);
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
    }

    results.push(...leafResults);
  }
  return results;
}

/** Push a single endpoint leaf — find/create wiki child + renderAndPush. */
async function pushEndpointLeaf(args: {
  ctx: EndpointSyncContext;
  svcName: string;
  tagId: string;
  parentSpaceId: string;
  parentNodeToken: string;
  pool: Map<string, WikiChild[]>;
  slice: EndpointSlice;
  larkBin: string;
  outDirRelTag: string;
  labelPrefixExtra?: string;
}): Promise<ServiceResult> {
  const { ctx, svcName, tagId, parentSpaceId, parentNodeToken, pool, slice, larkBin, outDirRelTag, labelPrefixExtra } = args;
  const leafTitle = titleForEndpoint(slice);
  let leaf = popFromPool(pool, leafTitle);
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

function poolByTitle(children: WikiChild[]): Map<string, WikiChild[]> {
  const m = new Map<string, WikiChild[]>();
  for (const c of children) {
    const k = c.title.trim().toLowerCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(c);
  }
  return m;
}

function popFromPool(pool: Map<string, WikiChild[]>, title: string): WikiChild | undefined {
  const k = title.trim().toLowerCase();
  const arr = pool.get(k);
  if (arr && arr.length > 0) return arr.shift();
  // Inverse-order match: "X — Y" and "Y — X" carry the same operation but
  // different title order. v1.4 reversed the default order (summary first),
  // so existing wiki nodes from v1.3 are titled "METHOD path — summary" and
  // would no longer match new "summary — METHOD path" titles. Try the swap.
  const parts = title.split(' — ');
  if (parts.length === 2) {
    const swapped = `${parts[1].trim()} — ${parts[0].trim()}`.toLowerCase();
    const swapArr = pool.get(swapped);
    if (swapArr && swapArr.length > 0) return swapArr.shift();
  }
  // Zombie recovery (titles clobbered by prior failed sync)
  for (const zk of ['untitled', 'authentication']) {
    const z = pool.get(zk);
    if (z && z.length > 0) return z.shift();
  }
  return undefined;
}

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
  writeFileSync(absPath, markdown, 'utf8');

  // Hash check: skip push if content unchanged from last successful sync
  const hash = sha256(markdown);
  const prior = lockLookup(ctx.lock, ctx.service.name, docToken);
  if (!ctx.force && prior && prior.sha256 === hash && prior.title === titleForLock) {
    return {
      service: label,
      status: 'skipped',
      durationMs: Date.now() - started,
      reason: `unchanged (sha256 match)`,
    };
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
    // Skip push + lockUpsert. Local md already written above.
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
  });
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
  writeFileSync(absPath, markdown, 'utf8');

  // Hash check: skip push if content unchanged
  const hash = sha256(markdown);
  const prior = lockLookup(ctx.lock, ctx.service.name, docToken);
  if (!ctx.force && prior && prior.sha256 === hash && prior.title === titleForLock) {
    return {
      service: label,
      status: 'skipped',
      durationMs: Date.now() - started,
      reason: `unchanged (sha256 match)`,
    };
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

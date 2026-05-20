import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import { loadAndDereference, renderApi, RenderError } from '../renderer/index.js';
import {
  splitByEndpoint,
  splitByTag,
  titleForEndpoint,
  titleForTag,
} from '../renderer/split-by-tag.js';
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

export interface EndpointSyncContext {
  config: Config;
  basedir: string;
  service: ServiceConfig;
  outDirRel: string;
  parallel: number;
  timeoutMs: number;
  pushBytesLimit: number;
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
    parent = resolveWikiNode(svc.docToken, larkBin);
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
  process.stdout.write(
    `[sync] ${svc.name}: wiki parent resolved (space=${parent.spaceId}, title="${parent.title}")\n`,
  );

  const openapiPath = resolve(ctx.basedir, svc.openapi);
  let api: unknown;
  try {
    ({ api } = await loadAndDereference(
      openapiPath,
      ctx.config.maxResolvedSizeBytes ?? DEFAULT_MAX_RESOLVED_SIZE_BYTES,
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
  results.push(
    await renderAndPush({
      ctx,
      label: `${svc.name} :: overview`,
      api: tagSplit.overview,
      docToken: parent.objToken,
      outRel: `${ctx.outDirRel}/_overview.md`,
      titleForLock: parent.title || svc.name,
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
    } else {
      process.stdout.write(
        `[sync] ${svc.name}: recycled tag node ${tagNode.nodeToken} (was "${tagNode.title}") -> "${tagTitle}"\n`,
      );
    }

    // Render tag index (list of endpoints) to the tag docx
    results.push(
      await renderAndPush({
        ctx,
        label: `${svc.name} :: ${tagId} :: index`,
        api: tagSplit.byTag[tagId],
        docToken: tagNode.objToken,
        outRel: `${ctx.outDirRel}/${safeFilename(tagId)}/_index.md`,
        titleForLock: tagTitle,
      }),
    );

    // List existing endpoint leaves under this tag
    let leafChildren: WikiChild[];
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
    const leafPool = poolByTitle(leafChildren);

    // Endpoints under this tag
    const slices = endpoints.filter((e) => e.tagId === tagId);
    process.stdout.write(`[sync] ${svc.name}: ${tagId} has ${slices.length} endpoint(s)\n`);

    const limit = pLimit(ctx.parallel);
    const slicePushTasks = slices.map((slice) => async () => {
      const leafTitle = titleForEndpoint(slice);
      let leaf = popFromPool(leafPool, leafTitle);
      if (!leaf) {
        try {
          leaf = createWikiChild(
            parent.spaceId,
            tagNode!.nodeToken,
            leafTitle,
            larkBin,
          );
        } catch (err) {
          return {
            service: `${svc.name} :: ${tagId} :: ${leafTitle}`,
            status: 'failed' as const,
            durationMs: 0,
            reason: `createWikiChild(leaf) failed: ${(err as Error).message}`,
          };
        }
      }
      return renderAndPush({
        ctx,
        label: `${svc.name} :: ${tagId} :: ${leafTitle}`,
        api: slice.api,
        docToken: leaf.objToken,
        outRel: `${ctx.outDirRel}/${safeFilename(tagId)}/${safeFilename(leafTitle)}.md`,
        titleForLock: leafTitle,
      });
    });

    // NOTE: createWikiChild must be SEQUENTIAL to avoid claiming the same pool
    // slot or creating duplicate leaves under high parallelism. Push is the
    // slow step (~1-2s), so we parallelize there.
    const leafResults: ServiceResult[] = [];
    for (const task of slicePushTasks) {
      const r = await limit(task);
      leafResults.push(r);
    }
    results.push(...leafResults);
  }
  return results;
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
  // Try "untitled" zombie recovery
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
}

async function renderAndPush(args: RAPArgs): Promise<ServiceResult> {
  const { ctx, label, api, docToken, outRel, titleForLock } = args;
  const started = Date.now();
  let markdown: string;
  let warnings;
  try {
    const out = await renderApi(api);
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
  const pushed = push({
    docToken,
    mdPath: outRel,
    cwd: ctx.basedir,
    larkBin: ctx.config.larkBin,
    timeoutMs: ctx.timeoutMs,
  });
  if (pushed.ok) {
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

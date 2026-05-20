import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import { loadAndDereference, renderApi, RenderError } from '../renderer/index.js';
import { splitByTag, titleForTag } from '../renderer/split-by-tag.js';
import { groupHeadingWarnings } from '../renderer/heading-check.js';
import { push } from '../lark/push.js';
import { resolveWikiNode, listWikiChildren, createWikiChild, WikiError } from '../lark/wiki.js';
import {
  DEFAULT_MAX_RESOLVED_SIZE_BYTES,
  type Config,
  type ServiceConfig,
  type ServiceResult,
} from '../types.js';

export interface TreeSyncContext {
  config: Config;
  basedir: string;
  service: ServiceConfig;
  /** Path-relative-to-basedir prefix for output files (e.g. ".openapi-lark/voice-room") */
  outDirRel: string;
  parallelChildren: number;
  timeoutMs: number;
  pushBytesLimit: number;
}

/**
 * Sync one service in tree mode.
 *
 * Workflow:
 *  1. Resolve docToken as a wiki node → get spaceId + parent obj_token
 *  2. Dereference openapi, split by first tag
 *  3. Render overview to parent docx
 *  4. For each tag bucket:
 *     a. find existing child node by title; create if absent
 *     b. render the sub-api, write to disk, push to child's docx
 *  5. Aggregate results: one ServiceResult per (overview + each tag)
 */
export async function runTreeSync(ctx: TreeSyncContext): Promise<ServiceResult[]> {
  const results: ServiceResult[] = [];
  const svc = ctx.service;
  const t0 = Date.now();

  // Step 1: resolve the wiki node
  let parent: ReturnType<typeof resolveWikiNode>;
  try {
    parent = resolveWikiNode(svc.docToken, ctx.config.larkBin ?? 'lark-cli');
  } catch (err) {
    return [
      {
        service: svc.name,
        status: 'failed',
        durationMs: Date.now() - t0,
        reason: err instanceof WikiError ? err.message : (err as Error).message,
      },
    ];
  }
  process.stdout.write(
    `[sync] ${svc.name}: wiki parent resolved (space=${parent.spaceId}, title="${parent.title}")\n`,
  );

  // Step 2: load openapi + split
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
        durationMs: Date.now() - t0,
        reason: err instanceof RenderError ? err.message : (err as Error).message,
      },
    ];
  }
  const split = splitByTag(api);

  // Apply include/exclude filters
  const allTags = Object.keys(split.byTag);
  const wanted = svc.includeTags?.length ? svc.includeTags : allTags;
  const tagIds = wanted.filter(
    (t) => allTags.includes(t) && !(svc.excludeTags ?? []).includes(t),
  );
  process.stdout.write(
    `[sync] ${svc.name}: split into ${tagIds.length} tag(s) + 1 overview\n`,
  );

  // Step 3: render + push overview to the parent docx
  mkdirSync(resolve(ctx.basedir, ctx.outDirRel), { recursive: true });
  results.push(
    await renderAndPush({
      ctx,
      label: `${svc.name} :: overview`,
      api: split.overview,
      docToken: parent.objToken,
      outRel: `${ctx.outDirRel}/_overview.md`,
    }),
  );

  // Step 4: list existing children once, build title→child map
  let children: Awaited<ReturnType<typeof listWikiChildren>>;
  try {
    children = listWikiChildren(
      parent.spaceId,
      parent.nodeToken,
      ctx.config.larkBin ?? 'lark-cli',
    );
  } catch (err) {
    results.push({
      service: svc.name,
      status: 'failed',
      durationMs: Date.now() - t0,
      reason: `listWikiChildren failed: ${(err as Error).message}`,
    });
    return results;
  }
  const childByTitle = new Map<string, (typeof children)[number]>();
  for (const c of children) childByTitle.set(c.title.trim().toLowerCase(), c);

  // Step 5: process tag buckets (parallel-limited)
  const limit = pLimit(ctx.parallelChildren);
  const tagResults = await Promise.all(
    tagIds.map((tagId) =>
      limit(async () => {
        const title = titleForTag(tagId, api, svc.tagAliases);
        let docToken: string;
        const existing = childByTitle.get(title.trim().toLowerCase());
        if (existing) {
          docToken = existing.objToken;
        } else {
          try {
            const created = createWikiChild(
              parent.spaceId,
              parent.nodeToken,
              title,
              ctx.config.larkBin ?? 'lark-cli',
            );
            docToken = created.objToken;
            process.stdout.write(
              `[sync] ${svc.name}: created child node "${title}" -> ${docToken}\n`,
            );
          } catch (err) {
            return {
              service: `${svc.name} :: ${tagId}`,
              status: 'failed' as const,
              durationMs: 0,
              reason: `createWikiChild failed: ${(err as Error).message}`,
            };
          }
        }
        return renderAndPush({
          ctx,
          label: `${svc.name} :: ${tagId}`,
          api: split.byTag[tagId],
          docToken,
          outRel: `${ctx.outDirRel}/tag-${safeFilename(tagId)}.md`,
        });
      }),
    ),
  );
  results.push(...tagResults);

  return results;
}

interface RenderAndPushArgs {
  ctx: TreeSyncContext;
  label: string;
  api: unknown;
  docToken: string;
  outRel: string;
}

async function renderAndPush(args: RenderAndPushArgs): Promise<ServiceResult> {
  const { ctx, label, api, docToken, outRel } = args;
  const started = Date.now();
  let markdown: string;
  let warnings;
  try {
    const out = await renderApi(api);
    markdown = out.markdown;
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
  writeFileSync(absPath, markdown, 'utf8');

  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > ctx.pushBytesLimit) {
    return {
      service: label,
      status: 'failed',
      durationMs: Date.now() - started,
      reason:
        `rendered ${(bytes / 1024).toFixed(0)} KB exceeds maxPushBytes ` +
        `(${(ctx.pushBytesLimit / 1024).toFixed(0)} KB) — split further by tag or raise the limit. ` +
        `Local md: ${absPath}`,
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
      reason: pushed.url ? undefined : 'pushed but no url returned',
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
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

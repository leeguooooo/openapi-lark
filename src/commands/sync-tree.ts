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
    parent = resolveWikiNode(svc.docToken!, ctx.config.larkBin ?? 'lark-cli');
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

  // Step 3: render + push overview to the parent docx.
  // Title precedence: svc.parentTitle (explicit) > existing parent title > svc.name
  mkdirSync(resolve(ctx.basedir, ctx.outDirRel), { recursive: true });
  const parentLockTitle = svc.parentTitle || parent.title || svc.name;
  results.push(
    await renderAndPush({
      ctx,
      label: `${svc.name} :: overview`,
      api: split.overview,
      docToken: parent.objToken,
      outRel: `${ctx.outDirRel}/_overview.md`,
      newTitle: parentLockTitle,
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
  // Build a pool of unclaimed children, indexed by lowercase title. We allow
  // multiple children per title (the wiki shows duplicates if a prior sync
  // failed mid-flight). Also collect "zombie" children whose title was clobbered
  // to a generic value (e.g. "Authentication" — observed when prior runs did
  // `docs +update --command overwrite` without --new-title and the widdershins
  // markdown's first H1 was taken as the docx title) — those are recyclable.
  const titlePool = new Map<string, (typeof children)[number][]>();
  for (const c of children) {
    const key = c.title.trim().toLowerCase();
    if (!titlePool.has(key)) titlePool.set(key, []);
    titlePool.get(key)!.push(c);
  }
  const ZOMBIE_TITLE_KEYS = ['authentication']; // observed clobber target
  const claimChild = (preferredTitle: string): typeof children[number] | undefined => {
    const exact = titlePool.get(preferredTitle.trim().toLowerCase());
    if (exact && exact.length > 0) return exact.shift();
    for (const k of ZOMBIE_TITLE_KEYS) {
      const z = titlePool.get(k);
      if (z && z.length > 0) return z.shift();
    }
    return undefined;
  };

  // Step 5: process tag buckets (parallel-limited)
  // NOTE: we MUST claim children sequentially before kicking off parallel
  // pushes, otherwise two tags could race and both claim the same child.
  const claimed: Array<{ tagId: string; title: string; docToken: string; created: boolean }> = [];
  for (const tagId of tagIds) {
    const title = titleForTag(tagId, api, svc.tagAliases);
    const existing = claimChild(title);
    if (existing) {
      claimed.push({ tagId, title, docToken: existing.objToken, created: false });
      continue;
    }
    try {
      const created = createWikiChild(
        parent.spaceId,
        parent.nodeToken,
        title,
        ctx.config.larkBin ?? 'lark-cli',
      );
      claimed.push({ tagId, title, docToken: created.objToken, created: true });
      process.stdout.write(
        `[sync] ${svc.name}: created child node "${title}" -> ${created.objToken}\n`,
      );
    } catch (err) {
      results.push({
        service: `${svc.name} :: ${tagId}`,
        status: 'failed',
        durationMs: 0,
        reason: `createWikiChild failed: ${(err as Error).message}`,
      });
    }
  }

  const limit = pLimit(ctx.parallelChildren);
  const tagResults = await Promise.all(
    claimed.map(({ tagId, title, docToken }) =>
      limit(async () => {
        return renderAndPush({
          ctx,
          label: `${svc.name} :: ${tagId}`,
          api: split.byTag[tagId],
          docToken,
          outRel: `${ctx.outDirRel}/tag-${safeFilename(tagId)}.md`,
          newTitle: title, // lock child title to the resolved tag title
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
  /** When set, push will issue --new-title to lock the wiki node title against
   *  widdershins' "first H1" title-stealing behavior. */
  newTitle?: string;
}

async function renderAndPush(args: RenderAndPushArgs): Promise<ServiceResult> {
  const { ctx, label, api, docToken, outRel, newTitle } = args;
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

  // Real-world calibration: lark-cli docs +update --command overwrite IGNORES
  // --new-title and steals the docx title from the FIRST `# H1` in the markdown
  // body (often "Authentication" from widdershins' auto-generated section).
  // Workaround: strip widdershins front-matter and prepend `# <newTitle>` as
  // the absolute first H1 so lark-cli locks onto our intended title.
  if (newTitle) {
    markdown = lockTitleInMarkdown(markdown, newTitle);
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
    // We don't pass newTitle to push — lark-cli --new-title is unreliable
    // (verified 2026-05-20 with v1.0.32). Title is now locked via in-markdown
    // injection in lockTitleInMarkdown above.
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
  // Keep ASCII word chars + CJK unified ideographs; replace others with _.
  // Without CJK preservation, voice-room tags 语音房/管理端/... all collapse to "_"
  // and the per-tag .md files overwrite each other.
  return s.replace(/[^a-zA-Z0-9._\-一-鿿]+/g, '_').slice(0, 80);
}

/**
 * Force the docx + wiki-node title to `title`.
 *
 * Real-world calibration (lark-cli 1.0.32 + ap-southeast-1) — controlled tests:
 *   - YAML front-matter `title:` is IGNORED; rendered as `## title: X` in body
 *   - `--new-title X` under `--command overwrite` is IGNORED
 *   - With EXACTLY one `# H1` in markdown → that H1 becomes the docx title
 *     (and is removed from body)
 *   - With MULTIPLE `# H1`s → docx title defaults to "Untitled"; all H1s
 *     remain in body
 *   - No H1 → docx title = "Untitled"
 *
 * Strategy: ensure exactly ONE H1, at the very top, equal to our desired title:
 *   1. strip widdershins YAML front-matter (its `title:` doesn't help)
 *   2. demote every other markdown `# X` (and HTML `<h1>`) to H2
 *   3. prepend `# <title>` as the absolute first line
 */
export function lockTitleInMarkdown(md: string, title: string): string {
  let body = md;
  if (body.startsWith('---')) {
    const closeIdx = body.indexOf('\n---', 3);
    if (closeIdx > 0) {
      body = body.slice(closeIdx + 4).replace(/^\n+/, '');
    }
  }
  // Demote markdown # H1 → ## H2 (line-start, not inside code blocks)
  // Quick heuristic: replace `^# ` with `## ` outside fenced code blocks.
  body = demoteH1(body);
  // Demote raw <h1>...</h1> HTML tags too — widdershins emits these for the
  // openapi info.title block. Lark-cli mostly ignores HTML tags for title
  // resolution, but turning them into <h2> avoids competing H1 entries.
  body = body.replace(/<h1\b/gi, '<h2').replace(/<\/h1>/gi, '</h2>');

  return `# ${title}\n\n${body}`;
}

function demoteH1(md: string): string {
  const lines = md.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // ATX-style H1: `# heading`. Skip H1 anchored at start that is actually H2+.
      if (/^# (?!#)/.test(line)) return '#' + line; // `# foo` → `## foo`
      return line;
    })
    .join('\n');
}

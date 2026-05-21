import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import { loadConfig, resolveOpenapiPath, ConfigError } from '../config/load.js';
import { render, RenderError } from '../renderer/index.js';
import { groupHeadingWarnings } from '../renderer/heading-check.js';
import { runTreeSync } from './sync-tree.js';
import { runEndpointSync } from './sync-endpoint.js';
import { loadLock, saveLock } from '../sync-lock.js';
import { loadNodeMap, saveNodeMap } from '../node-map.js';
import { resolveDocTokens } from './resolve-doctokens.js';
import { preflight, PreflightError } from '../lark/preflight.js';
import { push } from '../lark/push.js';
import {
  EXIT_BUSINESS,
  EXIT_CONFIG,
  EXIT_ENV,
  EXIT_OK,
  type Engine,
  type ServiceResult,
} from '../types.js';
import { renderSummaryTable } from '../report.js';

export interface SyncArgs {
  service?: string;
  configPath: string;
  dryRun?: boolean;
  engine?: Engine;
  parallel?: number;
  pushTimeoutMs?: number;
  /** Skip hash cache; force re-push every leaf. */
  force?: boolean;
  /** Print first 20 lines of unified diff per changed leaf (endpoint mode only). */
  showDiff?: boolean;
}

export async function runSync(args: SyncArgs): Promise<number> {
  let loaded;
  try {
    loaded = loadConfig({ configPath: args.configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[sync] config error: ${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }

  // Per spec: --engine native is not implemented in v1, returns exit 2 (not 1)
  if (args.engine === 'native') {
    process.stderr.write(
      `[sync] --engine native is not implemented in v1; see Phase v1.5 in the spec. Use widdershins.\n`,
    );
    return EXIT_CONFIG;
  }

  const services = args.service
    ? loaded.config.services.filter((s) => s.name === args.service)
    : loaded.config.services;
  if (services.length === 0) {
    process.stderr.write(`[sync] no service matched: ${args.service ?? '<all>'}\n`);
    return EXIT_CONFIG;
  }

  // Preflight runs in ALL modes (incl. dry-run). Spec data flow: preflight → lint → render → push.
  // --dry-run only skips the push step; environment must still be valid.
  try {
    const p = preflight({
      larkBin: loaded.config.larkBin,
      larkCliRange: loaded.config.engines.larkCli,
    });
    process.stdout.write(`[sync] preflight ok: ${p.bin} ${p.version}\n`);
  } catch (err) {
    if (err instanceof PreflightError) {
      process.stderr.write(`[sync] preflight failed: ${err.message}\n`);
      return EXIT_ENV;
    }
    throw err;
  }

  // --parallel validation
  let parallel = args.parallel ?? 1;
  if (parallel <= 0) {
    process.stderr.write(`[sync] --parallel must be >= 1, got ${parallel}\n`);
    return EXIT_CONFIG;
  }
  parallel = Math.min(parallel, services.length);
  const limit = pLimit(parallel);

  const timeoutMs = args.pushTimeoutMs ?? loaded.config.pushTimeoutMs;
  const results: ServiceResult[] = new Array(services.length);

  // Resolve missing docTokens by auto-creating wiki children under
  // config.parentDocToken (v1.8). Mutates services in place; persists tokens
  // to .openapi-lark/auto-tokens.json for reuse.
  try {
    const autoStats = resolveDocTokens(
      loaded.basedir,
      loaded.config,
      loaded.config.larkBin ?? 'lark-cli',
    );
    if (autoStats.assigned > 0) {
      process.stdout.write(
        `[sync] resolved ${autoStats.assigned} docToken(s): ` +
          `${autoStats.created} created, ${autoStats.reused} reused from cache\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[sync] docToken resolution failed: ${(err as Error).message}\n`);
    return EXIT_CONFIG;
  }

  // Lockfile: shared across all services in this run. Loaded once, saved once at end.
  const lock = loadLock(loaded.basedir);
  // Stable identity map: tagId/groupKey/METHOD-path → wiki nodeToken.
  // Survives summary / tagAlias changes that used to leave zombie wiki nodes.
  // See src/node-map.ts.
  const nodeMap = loadNodeMap(loaded.basedir);

  await Promise.all(
    services.map((svc, idx) =>
      limit(async () => {
        const started = Date.now();
        const engine: Engine = args.engine ?? svc.render?.engine ?? 'widdershins';
        const openapiPath = resolveOpenapiPath(loaded.basedir, svc.openapi);

        // Endpoint mode: 3-level tree, leaf = single (path, method)
        if (svc.mode === 'endpoint') {
          if (args.dryRun) {
            process.stdout.write(
              `[sync] ${svc.name}: endpoint mode dry-run — rendering all leaves to disk only\n`,
            );
          }
          try {
            const epResults = await runEndpointSync({
              config: loaded.config,
              basedir: loaded.basedir,
              service: svc,
              outDirRel: `.openapi-lark/${svc.name}`,
              parallel,
              timeoutMs,
              pushBytesLimit: loaded.config.maxPushBytes,
              force: args.force,
              lock,
              nodeMap,
              dryRun: args.dryRun,
              showDiff: args.showDiff,
            });
            const failed = epResults.filter((r) => r.status === 'failed').length;
            const oks = epResults.filter((r) => r.status === 'ok').length;
            const warns = epResults.filter((r) => r.status === 'warning').length;
            const skipped = epResults.filter((r) => r.status === 'skipped').length;
            results[idx] = {
              service: svc.name,
              status: failed > 0 ? 'failed' : warns > 0 ? 'warning' : 'ok',
              durationMs: Date.now() - started,
              reason: `endpoint: ${oks} ok / ${failed} failed / ${warns} warning / ${skipped} skipped across ${epResults.length} parts`,
            };
            for (const r of epResults) {
              const sym =
                r.status === 'ok'
                  ? '✓'
                  : r.status === 'failed'
                    ? '✗'
                    : r.status === 'warning'
                      ? '⚠'
                      : '·';
              process.stdout.write(
                `[sync]   ${sym} ${r.service} ${r.docUrl ?? r.reason ?? ''} (${(r.durationMs / 1000).toFixed(1)}s)\n`,
              );
            }
          } catch (err) {
            results[idx] = {
              service: svc.name,
              status: 'failed',
              durationMs: Date.now() - started,
              reason: `endpoint sync error: ${(err as Error).message}`,
            };
          }
          return;
        }

        // Tree mode: split by tag, render each, push to child wiki nodes
        if (svc.mode === 'tree') {
          if (args.dryRun) {
            // Tree dry-run: still render all parts to disk, skip wiki API and push
            process.stdout.write(
              `[sync] ${svc.name}: tree mode dry-run — rendering subtree to disk only\n`,
            );
          }
          try {
            const treeResults = await runTreeSync({
              config: loaded.config,
              basedir: loaded.basedir,
              service: svc,
              outDirRel: `.openapi-lark/${svc.name}`,
              parallelChildren: parallel,
              timeoutMs,
              pushBytesLimit: loaded.config.maxPushBytes,
              dryRun: args.dryRun,
              showDiff: args.showDiff,
            });
            // Aggregate tree results into a single ServiceResult for the table.
            // Detailed per-tag rows printed separately below.
            const failed = treeResults.filter((r) => r.status === 'failed').length;
            const oks = treeResults.filter((r) => r.status === 'ok').length;
            const warns = treeResults.filter((r) => r.status === 'warning').length;
            results[idx] = {
              service: svc.name,
              status: failed > 0 ? 'failed' : warns > 0 ? 'warning' : 'ok',
              durationMs: Date.now() - started,
              reason: `tree: ${oks} ok / ${failed} failed / ${warns} warning across ${treeResults.length} parts`,
            };
            for (const r of treeResults) {
              const sym =
                r.status === 'ok'
                  ? '✓'
                  : r.status === 'failed'
                    ? '✗'
                    : r.status === 'warning'
                      ? '⚠'
                      : '·';
              process.stdout.write(
                `[sync]   ${sym} ${r.service} ${r.docUrl ?? r.reason ?? ''} (${(r.durationMs / 1000).toFixed(1)}s)\n`,
              );
            }
          } catch (err) {
            results[idx] = {
              service: svc.name,
              status: 'failed',
              durationMs: Date.now() - started,
              reason: `tree sync error: ${(err as Error).message}`,
            };
          }
          return;
        }

        try {
          const result = await render({
            openapiPath,
            engine,
            maxResolvedSizeBytes: loaded.config.maxResolvedSizeBytes,
            urlOpts: {
              headers: svc.openapiHeaders,
              snapshotAbsPath: svc.openapiSnapshot
                ? resolve(loaded.basedir, svc.openapiSnapshot)
                : undefined,
            },
          });
          // Group identical heading-jump warnings so 200 widdershins-emitted
          // "Enumerated Values" lines collapse to one summary row.
          const grouped = groupHeadingWarnings(result.headingWarnings);
          for (const g of grouped) {
            const samples = g.sampleLines.join(', ');
            const more = g.count > g.sampleLines.length ? ', …' : '';
            process.stderr.write(
              `[sync] ${svc.name}: heading jump H${g.from} → H${g.to} ` +
                `"${g.pattern}" ×${g.count} (lines ${samples}${more}) — see KNOWN_ISSUES #5\n`,
            );
          }
          const outDir = resolve(loaded.basedir, '.openapi-lark');
          mkdirSync(outDir, { recursive: true });
          const absOutPath = resolve(outDir, `${svc.name}.md`);
          // Path passed to lark-cli: relative to basedir (lark-cli rejects absolute)
          const relOutPath = `.openapi-lark/${svc.name}.md`;
          writeFileSync(absOutPath, result.markdown, 'utf8');

          if (args.dryRun) {
            results[idx] = {
              service: svc.name,
              status: 'ok',
              durationMs: Date.now() - started,
              reason: `dry-run; wrote ${absOutPath}`,
            };
            return;
          }

          // Size guard — fail fast before lark-cli hits server timeout (~60s)
          const renderedBytes = Buffer.byteLength(result.markdown, 'utf8');
          if (renderedBytes > loaded.config.maxPushBytes) {
            results[idx] = {
              service: svc.name,
              status: 'failed',
              durationMs: Date.now() - started,
              reason:
                `rendered ${(renderedBytes / 1024).toFixed(0)} KB exceeds maxPushBytes ` +
                `(${(loaded.config.maxPushBytes / 1024).toFixed(0)} KB). ` +
                `Feishu docx server times out around 1 MB. ` +
                `Options: (1) raise maxPushBytes if you've verified your tenant handles it; ` +
                `(2) trim the openapi (filter tags / hide internal endpoints); ` +
                `(3) split into multiple services with separate docTokens. ` +
                `Local render saved at ${absOutPath}.`,
            };
            return;
          }

          const pushed = push({
            docToken: svc.docToken!,
            mdPath: relOutPath,
            cwd: loaded.basedir,
            larkBin: loaded.config.larkBin,
            timeoutMs,
          });
          if (pushed.ok) {
            results[idx] = {
              service: svc.name,
              status: pushed.url ? 'ok' : 'warning',
              docUrl: pushed.url ?? undefined,
              durationMs: Date.now() - started,
              reason: pushed.url ? undefined : 'pushed but no url returned',
            };
          } else {
            results[idx] = {
              service: svc.name,
              status: 'failed',
              durationMs: Date.now() - started,
              reason: `${pushed.reason}: ${pushed.message}`,
            };
          }
        } catch (err) {
          const msg =
            err instanceof RenderError
              ? err.message
              : `unexpected error: ${(err as Error).message}`;
          results[idx] = {
            service: svc.name,
            status: 'failed',
            durationMs: Date.now() - started,
            reason: msg,
          };
        }
      }),
    ),
  );

  // Persist hash cache so next run can skip unchanged docs
  if (!args.dryRun) {
    try {
      saveLock(loaded.basedir, lock);
    } catch (err) {
      process.stderr.write(
        `[sync] warning: failed to save lockfile: ${(err as Error).message}\n`,
      );
    }
    // Persist identity → nodeToken map for stable recycling across summary/alias drift.
    try {
      saveNodeMap(loaded.basedir, nodeMap);
    } catch (err) {
      process.stderr.write(
        `[sync] warning: failed to save node-map: ${(err as Error).message}\n`,
      );
    }
  }

  // Always print in declaration order, not completion order
  process.stdout.write('\n' + renderSummaryTable(results) + '\n');
  const failed = results.filter((r) => r.status === 'failed').length;
  return failed === 0 ? EXIT_OK : EXIT_BUSINESS;
}

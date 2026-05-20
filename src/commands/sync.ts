import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import { loadConfig, resolveOpenapiPath, ConfigError } from '../config/load.js';
import { render, RenderError } from '../renderer/index.js';
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
    const p = preflight({ larkCliRange: loaded.config.engines.larkCli });
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

  await Promise.all(
    services.map((svc, idx) =>
      limit(async () => {
        const started = Date.now();
        const engine: Engine = args.engine ?? svc.render?.engine ?? 'widdershins';
        const openapiPath = resolveOpenapiPath(loaded.basedir, svc.openapi);
        try {
          const result = await render({
            openapiPath,
            engine,
            maxResolvedSizeBytes: loaded.config.maxResolvedSizeBytes,
          });
          for (const w of result.headingWarnings) {
            process.stderr.write(
              `[sync] ${svc.name}: heading jump H${w.from} → H${w.to} at line ${w.line} ("${w.text}") — see KNOWN_ISSUES #5\n`,
            );
          }
          const outPath = resolve(
            loaded.basedir,
            '.openapi-lark',
            `${svc.name}.md`,
          );
          mkdirSync(resolve(loaded.basedir, '.openapi-lark'), { recursive: true });
          writeFileSync(outPath, result.markdown, 'utf8');

          if (args.dryRun) {
            results[idx] = {
              service: svc.name,
              status: 'ok',
              durationMs: Date.now() - started,
              reason: `dry-run; wrote ${outPath}`,
            };
            return;
          }

          const pushed = push({
            docToken: svc.docToken,
            mdPath: outPath,
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

  // Always print in declaration order, not completion order
  process.stdout.write('\n' + renderSummaryTable(results) + '\n');
  const failed = results.filter((r) => r.status === 'failed').length;
  return failed === 0 ? EXIT_OK : EXIT_BUSINESS;
}

#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { findConfigPath } from './config/load.js';
import { runLint } from './commands/lint.js';
import { runRender } from './commands/render.js';
import { runSync } from './commands/sync.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { EXIT_CONFIG, type Engine } from './types.js';

function parseEngine(value: string): Engine {
  if (value !== 'widdershins' && value !== 'native') {
    throw new InvalidArgumentError(
      `unknown engine "${value}". v1 only supports "widdershins" (passing "native" returns exit 2 — see spec Phase v1.5).`,
    );
  }
  return value;
}

function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new InvalidArgumentError(`expected positive integer, got "${value}"`);
  }
  return n;
}

function getVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname ?? '.', '../package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0-unknown';
  }
}

function requireConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const found = findConfigPath(process.cwd());
  if (!found) {
    process.stderr.write(
      `no .openapi-lark.yaml found in ${process.cwd()} or any parent.\n` +
        `Run: openapi-lark init --name <svc> --openapi <path> --doc-url <url>\n`,
    );
    process.exit(EXIT_CONFIG);
  }
  return found;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('openapi-lark')
    .description('OpenAPI → 飞书 docx 文档同步')
    .version(getVersion());

  program
    .command('init')
    .description('Generate or append .openapi-lark.yaml')
    .requiredOption('--name <name>', 'service name')
    .requiredOption('--openapi <path>', 'path to openapi.yaml (relative to config)')
    .requiredOption('--doc-url <url>', 'Feishu docx URL; docToken is extracted from it')
    .option('--config <path>', 'config path (default: ./.openapi-lark.yaml)')
    .action(async (opts: { name: string; openapi: string; docUrl: string; config?: string }) => {
      const code = await runInit({
        name: opts.name,
        openapi: opts.openapi,
        docUrl: opts.docUrl,
        configPath: opts.config
          ? resolve(opts.config)
          : resolve(process.cwd(), '.openapi-lark.yaml'),
      });
      process.exit(code);
    });

  program
    .command('lint [service]')
    .description('Validate config + openapi syntax. Offline.')
    .option('--config <path>', 'config path')
    .action(async (service: string | undefined, opts: { config?: string }) => {
      const code = await runLint({
        service,
        configPath: requireConfigPath(opts.config),
      });
      process.exit(code);
    });

  program
    .command('render <service>')
    .description('Render markdown to ./.openapi-lark/<svc>.md (no push)')
    .option('--config <path>', 'config path')
    .option('--out <path>', 'override output path')
    .option('--engine <engine>', 'widdershins | native (v1 only widdershins)', parseEngine)
    .action(
      async (
        service: string,
        opts: { config?: string; out?: string; engine?: Engine },
      ) => {
        const code = await runRender({
          service,
          configPath: requireConfigPath(opts.config),
          out: opts.out,
          engine: opts.engine,
        });
        process.exit(code);
      },
    );

  program
    .command('sync [service]')
    .description('End-to-end: preflight → lint → render → push')
    .option('--config <path>', 'config path')
    .option('--dry-run', 'render but do not push')
    .option('--engine <engine>', 'widdershins | native (v1 only widdershins)', parseEngine)
    .option('--parallel <n>', 'max concurrent services', parsePositiveInt)
    .option('--push-timeout <ms>', 'per-service push timeout in ms', parsePositiveInt)
    .action(
      async (
        service: string | undefined,
        opts: {
          config?: string;
          dryRun?: boolean;
          engine?: Engine;
          parallel?: number;
          pushTimeout?: number;
        },
      ) => {
        const code = await runSync({
          service,
          configPath: requireConfigPath(opts.config),
          dryRun: opts.dryRun,
          engine: opts.engine,
          parallel: opts.parallel,
          pushTimeoutMs: opts.pushTimeout,
        });
        process.exit(code);
      },
    );

  program
    .command('doctor')
    .description('Diagnose environment (lark-cli, auth, docToken sanity, resolved size)')
    .option('--config <path>', 'config path')
    .action(async (opts: { config?: string }) => {
      const code = await runDoctor({
        configPath: opts.config
          ? resolve(opts.config)
          : findConfigPath(process.cwd()) ?? undefined,
      });
      process.exit(code);
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig, resolveOpenapiPath, ConfigError } from '../config/load.js';
import { render, RenderError } from '../renderer/index.js';
import { groupHeadingWarnings } from '../renderer/heading-check.js';
import {
  EXIT_BUSINESS,
  EXIT_CONFIG,
  EXIT_OK,
  type Engine,
} from '../types.js';

export interface RenderArgs {
  service: string;
  configPath: string;
  out?: string;
  engine?: Engine;
}

export async function runRender(args: RenderArgs): Promise<number> {
  let loaded;
  try {
    loaded = loadConfig({ configPath: args.configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[render] config error: ${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }
  const svc = loaded.config.services.find((s) => s.name === args.service);
  if (!svc) {
    process.stderr.write(`[render] service not found: ${args.service}\n`);
    return EXIT_CONFIG;
  }
  // Per spec: --engine native is not implemented in v1, returns exit 2 (not 1)
  if (args.engine === 'native') {
    process.stderr.write(
      `[render] --engine native is not implemented in v1; see Phase v1.5 in the spec. Use widdershins.\n`,
    );
    return EXIT_CONFIG;
  }
  const engine: Engine = args.engine ?? svc.render?.engine ?? 'widdershins';
  const openapiPath = resolveOpenapiPath(loaded.basedir, svc.openapi);
  try {
    const result = await render({
      openapiPath,
      engine,
      maxResolvedSizeBytes: loaded.config.maxResolvedSizeBytes,
    });
    const outPath = args.out
      ? resolve(process.cwd(), args.out)
      : resolve(loaded.basedir, '.openapi-lark', `${svc.name}.md`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.markdown, 'utf8');
    process.stdout.write(
      `[render] ${svc.name}: wrote ${result.markdown.length} bytes to ${outPath} (resolved ${(result.resolvedSizeBytes / 1024).toFixed(1)} KB)\n`,
    );
    const grouped = groupHeadingWarnings(result.headingWarnings);
    for (const g of grouped) {
      const samples = g.sampleLines.join(', ');
      const more = g.count > g.sampleLines.length ? ', …' : '';
      process.stderr.write(
        `[render] ${svc.name}: heading jump H${g.from} → H${g.to} ` +
          `"${g.pattern}" ×${g.count} (lines ${samples}${more}) — see KNOWN_ISSUES #5\n`,
      );
    }
    return EXIT_OK;
  } catch (err) {
    if (err instanceof RenderError) {
      process.stderr.write(`[render] ${svc.name}: ${err.message}\n`);
      return EXIT_BUSINESS;
    }
    throw err;
  }
}

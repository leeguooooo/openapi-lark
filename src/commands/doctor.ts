import SwaggerParser from '@apidevtools/swagger-parser';
import { existsSync, statSync } from 'node:fs';
import { findConfigPath, loadConfig, resolveOpenapiPath, ConfigError } from '../config/load.js';
import { preflight, PreflightError } from '../lark/preflight.js';
import { EXIT_ENV, EXIT_OK } from '../types.js';

export interface DoctorArgs {
  configPath?: string;
}

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
}

export async function runDoctor(args: DoctorArgs): Promise<number> {
  const checks: Check[] = [];

  // 1. config exists
  const cfgPath = args.configPath ?? findConfigPath(process.cwd());
  if (!cfgPath) {
    checks.push({
      name: 'config',
      status: 'skipped',
      detail: 'no .openapi-lark.yaml found — environment checks only',
    });
  } else {
    checks.push({ name: 'config', status: 'pass', detail: cfgPath });
  }

  let loaded: ReturnType<typeof loadConfig> | undefined;
  if (cfgPath) {
    try {
      loaded = loadConfig({ configPath: cfgPath });
      checks.push({
        name: 'config.parse',
        status: 'pass',
        detail: `${loaded.config.services.length} service(s)`,
      });
    } catch (err) {
      checks.push({
        name: 'config.parse',
        status: 'fail',
        detail: err instanceof ConfigError ? err.message : (err as Error).message,
      });
    }
  }

  // 2. lark-cli preflight (requires engines.larkCli; we use loaded config if available)
  if (loaded) {
    try {
      const p = preflight({ larkCliRange: loaded.config.engines.larkCli });
      checks.push({
        name: 'lark-cli',
        status: 'pass',
        detail: `${p.bin} ${p.version} satisfies ${loaded.config.engines.larkCli}`,
      });
    } catch (err) {
      checks.push({
        name: 'lark-cli',
        status: 'fail',
        detail: err instanceof PreflightError ? err.message : (err as Error).message,
      });
    }
  } else {
    // No config — still check that lark binary exists at all
    try {
      const p = preflight({ larkCliRange: '>=0.0.0' });
      checks.push({
        name: 'lark-cli',
        status: 'pass',
        detail: `${p.bin} ${p.version} (no engines constraint without config)`,
      });
    } catch (err) {
      checks.push({
        name: 'lark-cli',
        status: 'fail',
        detail: err instanceof PreflightError ? err.message : (err as Error).message,
      });
    }
  }

  // 3. per-service checks
  if (loaded) {
    for (const svc of loaded.config.services) {
      const openapiPath = resolveOpenapiPath(loaded.basedir, svc.openapi);
      if (!existsSync(openapiPath)) {
        checks.push({
          name: `service:${svc.name}.openapi`,
          status: 'fail',
          detail: `file not found at ${openapiPath}`,
        });
        continue;
      }
      try {
        const api = await SwaggerParser.dereference(openapiPath);
        const size = Buffer.byteLength(JSON.stringify(api), 'utf8');
        const exceed = size > loaded.config.maxResolvedSizeBytes;
        checks.push({
          name: `service:${svc.name}.openapi`,
          status: exceed ? 'fail' : 'pass',
          detail: `resolved ${(size / 1024 / 1024).toFixed(2)} MB (limit ${(loaded.config.maxResolvedSizeBytes / 1024 / 1024).toFixed(2)} MB)`,
        });
      } catch (err) {
        checks.push({
          name: `service:${svc.name}.openapi`,
          status: 'fail',
          detail: (err as Error).message,
        });
      }
      // docToken format sanity check (not authoritative — only catches obvious typos)
      if (svc.docToken.length < 8) {
        checks.push({
          name: `service:${svc.name}.docToken`,
          status: 'fail',
          detail: `docToken too short: "${svc.docToken}"`,
        });
      } else {
        checks.push({
          name: `service:${svc.name}.docToken`,
          status: 'skipped',
          detail: 'authoritative permission check requires real lark API call (v2)',
        });
      }
      void statSync; // reserved
    }
  }

  // Render report
  const colW = Math.max(20, ...checks.map((c) => c.name.length));
  for (const c of checks) {
    const sym = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '·';
    process.stdout.write(`  ${sym} ${c.name.padEnd(colW)}  ${c.detail}\n`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  process.stdout.write(
    `\n${checks.length - failed} ok / ${failed} failed / ${checks.filter((c) => c.status === 'skipped').length} skipped\n`,
  );
  return failed === 0 ? EXIT_OK : EXIT_ENV;
}

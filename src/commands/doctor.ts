import SwaggerParser from '@apidevtools/swagger-parser';
import { existsSync } from 'node:fs';
import { findConfigPath, loadConfig, resolveOpenapiPath, ConfigError } from '../config/load.js';
import { preflight, PreflightError, authStatus, authCheckScopes } from '../lark/preflight.js';
import { EXIT_ENV, EXIT_OK } from '../types.js';

/**
 * Scope hints for `lark-cli auth check`. The names come from Feishu Open
 * Platform (verified 2026-05) — `wiki:node:write` does NOT exist; the correct
 * name is `wiki:node:create`. Each entry is one scope we pass to
 * `lark-cli auth check`; lark-cli reports it as granted or missing.
 */
const SCOPES_FOR_SYNC = [
  'wiki:node:read',
  'wiki:node:create',
  'docx:document:write_only',
];

/** Token expires within this many ms → warn but still pass (≤ 6h by default). */
const SOON_EXPIRY_WARN_MS = 6 * 60 * 60 * 1000;

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
      const p = preflight({
        larkBin: loaded.config.larkBin,
        larkCliRange: loaded.config.engines.larkCli,
      });
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
      if (!svc.docToken) {
        checks.push({
          name: `service:${svc.name}.docToken`,
          status: 'skipped',
          detail: `no docToken yet — will be auto-created on next sync from parentDocToken`,
        });
      } else if (svc.docToken.length < 8) {
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
    }
  }

  // Auth probe: cheap local check via `lark-cli auth status` (no API call).
  // Catches: missing login, expired token, soon-to-expire token.
  // Does NOT catch scope-level gaps for newly-needed APIs (those still need a
  // real API call); but at least detects the "expired 1 day ago, sync ate 5 min
  // before erroring" failure mode.
  const auth = authStatus({ larkBin: loaded?.config.larkBin });
  if (!auth.ok) {
    checks.push({ name: 'auth', status: 'fail', detail: auth.reason ?? 'unknown auth failure' });
  } else {
    const expiryInfo = auth.expiresInMs !== undefined
      ? auth.expiresInMs < SOON_EXPIRY_WARN_MS
        ? ` — ⚠ expires in ${(auth.expiresInMs / 3600_000).toFixed(1)}h (${auth.expiresAt})`
        : ` (expires ${auth.expiresAt})`
      : '';
    checks.push({
      name: 'auth',
      status: 'pass',
      detail: `tokenStatus=${auth.tokenStatus ?? 'unknown'}, ${auth.scopes.length} scope(s)${expiryInfo}`,
    });
  }

  // Scope check — authoritative via `lark-cli auth check`. Only run when we have
  // a successful auth status. lark-cli ≥ 1.0.34 needed; older versions skip silently.
  if (auth.ok) {
    const scopeCheck = authCheckScopes({
      scopes: SCOPES_FOR_SYNC,
      larkBin: loaded?.config.larkBin,
    });
    if (scopeCheck === null) {
      checks.push({
        name: 'auth.scopes',
        status: 'skipped',
        detail: 'lark-cli auth check unavailable (need ≥ 1.0.34); cannot verify scopes',
      });
    } else if (scopeCheck.ok) {
      checks.push({
        name: 'auth.scopes',
        status: 'pass',
        detail: `granted: ${scopeCheck.granted.join(', ')}`,
      });
    } else {
      const bin = loaded?.config.larkBin ?? 'lark-cli';
      const missing = scopeCheck.missing.join(' ');
      checks.push({
        name: 'auth.scopes',
        status: 'fail',
        detail:
          `missing scope(s): ${missing}. Run \`${bin} auth login --scope "${missing}"\` (or --recommend)`,
      });
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

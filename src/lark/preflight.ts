import { spawnSync } from 'node:child_process';
import semver from 'semver';
import { EXIT_ENV } from '../types.js';

export class PreflightError extends Error {
  exitCode = EXIT_ENV;
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export interface PreflightInput {
  larkBin?: string;
  larkCliRange: string;
  /** Pass-through for testing — override process.env */
  env?: NodeJS.ProcessEnv;
}

export interface PreflightResult {
  bin: string;
  version: string;
}

/**
 * Probe `lark --version`, ensure it satisfies the configured semver range.
 * Throws PreflightError on missing binary, unparseable version, or mismatch.
 */
export function preflight(input: PreflightInput): PreflightResult {
  const bin = input.larkBin ?? 'lark-cli';
  const res = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    env: input.env ?? process.env,
    timeout: 10_000,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new PreflightError(
      `lark-cli binary "${bin}" not found in PATH. ` +
        `Install lark-cli (e.g. brew install lark-cli) or override with config field "larkBin".`,
    );
  }
  if (res.status !== 0) {
    throw new PreflightError(
      `${bin} --version exited ${res.status}: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  const versionLine = (res.stdout || '').trim().split('\n')[0] ?? '';
  const cleaned = semver.coerce(versionLine);
  if (!cleaned) {
    throw new PreflightError(
      `cannot parse lark-cli version from output: ${JSON.stringify(versionLine)}`,
    );
  }
  if (!semver.satisfies(cleaned, input.larkCliRange, { includePrerelease: true })) {
    throw new PreflightError(
      `lark-cli version ${cleaned.version} does not satisfy engines.larkCli "${input.larkCliRange}". Upgrade lark-cli or relax the constraint.`,
    );
  }
  return { bin, version: cleaned.version };
}

export interface AuthStatus {
  ok: boolean;
  /** RFC3339 — when the current access token expires */
  expiresAt?: string;
  /** ms until expiresAt; negative = already expired */
  expiresInMs?: number;
  /** Space-separated scope list as reported by lark-cli */
  scopes: string[];
  /** Raw `tokenStatus` field (lark-cli reports e.g. "valid") */
  tokenStatus?: string;
  /** Human-readable reason when ok === false */
  reason?: string;
}

/**
 * Best-effort `lark-cli auth status` probe. Returns structured result;
 * NEVER throws — caller decides whether to treat as fatal.
 *
 * Why: doctor previously skipped auth entirely and gave a false "ok",
 * letting expired tokens slide through until a 5-minute sync ate them.
 * `auth status` is the cheapest possible check (no API call, just reads
 * the local token file) — so doctor can always run it.
 *
 * Scope verification still requires a real API call; see scope-list check
 * elsewhere when needed.
 */
export function authStatus(input: { larkBin?: string; env?: NodeJS.ProcessEnv }): AuthStatus {
  const bin = input.larkBin ?? 'lark-cli';
  const res = spawnSync(bin, ['auth', 'status'], {
    encoding: 'utf8',
    env: input.env ?? process.env,
    timeout: 10_000,
  });
  if (res.error || res.status !== 0) {
    return {
      ok: false,
      scopes: [],
      reason: `${bin} auth status failed: ${(res.stderr || res.stdout || (res.error as Error)?.message || 'unknown').toString().trim().slice(0, 200)}`,
    };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout || '{}');
  } catch (err) {
    return {
      ok: false,
      scopes: [],
      reason: `${bin} auth status returned non-JSON: ${(err as Error).message}`,
    };
  }
  const scopes = typeof parsed.scope === 'string'
    ? parsed.scope.split(/\s+/).filter(Boolean)
    : [];
  const expiresAt: string | undefined = typeof parsed.expiresAt === 'string'
    ? parsed.expiresAt
    : undefined;
  const expiresInMs = expiresAt ? Date.parse(expiresAt) - Date.now() : undefined;
  const tokenStatus: string | undefined = typeof parsed.tokenStatus === 'string'
    ? parsed.tokenStatus
    : undefined;
  if (tokenStatus && tokenStatus !== 'valid') {
    return {
      ok: false,
      expiresAt,
      expiresInMs,
      scopes,
      tokenStatus,
      reason: `lark-cli token status is "${tokenStatus}" — run \`${bin} auth login\` to refresh`,
    };
  }
  if (expiresInMs !== undefined && expiresInMs <= 0) {
    return {
      ok: false,
      expiresAt,
      expiresInMs,
      scopes,
      tokenStatus,
      reason: `lark-cli token expired at ${expiresAt} — run \`${bin} auth login\` to refresh`,
    };
  }
  return { ok: true, expiresAt, expiresInMs, scopes, tokenStatus };
}

export interface ScopeCheckResult {
  ok: boolean;
  /** Scopes the token actually has from the requested list */
  granted: string[];
  /** Scopes the token is missing from the requested list */
  missing: string[];
  /** Human-readable reason when ok === false and check itself failed */
  reason?: string;
}

/**
 * Authoritative scope check via `lark-cli auth check --scope "..."`.
 * lark-cli ≥ 1.0.34 returns `{ok, granted, missing}` JSON; on older versions
 * the command may not exist — we detect that and degrade to "skipped".
 */
export function authCheckScopes(input: {
  scopes: string[];
  larkBin?: string;
  env?: NodeJS.ProcessEnv;
}): ScopeCheckResult | null {
  if (input.scopes.length === 0) return { ok: true, granted: [], missing: [] };
  const bin = input.larkBin ?? 'lark-cli';
  const res = spawnSync(bin, ['auth', 'check', '--scope', input.scopes.join(' ')], {
    encoding: 'utf8',
    env: input.env ?? process.env,
    timeout: 10_000,
  });
  // Subcommand missing (older lark-cli) → return null so caller can mark as skipped
  if (res.status !== 0 && /unknown command|invalid argument|help for/i.test(res.stderr || res.stdout || '')) {
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout || '{}');
  } catch {
    return {
      ok: false,
      granted: [],
      missing: input.scopes,
      reason: `${bin} auth check returned non-JSON; lark-cli too old? (need ≥ 1.0.34)`,
    };
  }
  return {
    ok: Boolean(parsed.ok),
    granted: Array.isArray(parsed.granted) ? parsed.granted : [],
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
  };
}

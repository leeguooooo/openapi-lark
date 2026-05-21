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
        `Install lark-cli via \`npx @larksuite/cli@latest install\` (see github.com/larksuite/cli) ` +
        `or override with config field "larkBin".`,
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
  /**
   * Three-state classification (was binary in v0.2.x; expanded to avoid the
   * v0.2.x false-positive where `needs_refresh` was reported as fail even
   * though the refresh token is still valid and sync would have auto-refreshed
   * on the next call).
   *
   *   'ok'   — tokenStatus=valid AND access token still valid
   *   'warn' — needs_refresh / soon-to-expire BUT refresh token still valid
   *            (sync will auto-refresh; user does NOT need to re-login)
   *   'fail' — expired AND refresh_expired, revoked, missing, or unparseable
   */
  state: 'ok' | 'warn' | 'fail';
  /** Convenience: state !== 'fail'. Callers that don't care about the warn
   *  distinction can keep using this. */
  ok: boolean;
  /** RFC3339 — when the current access token expires */
  expiresAt?: string;
  /** ms until expiresAt; negative = already expired */
  expiresInMs?: number;
  /** RFC3339 — when the refresh token itself expires (lark-cli reports this) */
  refreshExpiresAt?: string;
  /** ms until refreshExpiresAt; negative = refresh token also expired */
  refreshExpiresInMs?: number;
  /** Space-separated scope list as reported by lark-cli */
  scopes: string[];
  /** Raw `tokenStatus` field (lark-cli reports e.g. "valid", "needs_refresh") */
  tokenStatus?: string;
  /** Human-readable reason — set for both warn and fail states */
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
      state: 'fail',
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
      state: 'fail',
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
  const refreshExpiresAt: string | undefined = typeof parsed.refreshExpiresAt === 'string'
    ? parsed.refreshExpiresAt
    : undefined;
  const refreshExpiresInMs = refreshExpiresAt
    ? Date.parse(refreshExpiresAt) - Date.now()
    : undefined;
  const tokenStatus: string | undefined = typeof parsed.tokenStatus === 'string'
    ? parsed.tokenStatus
    : undefined;

  // Classify. Order matters: hard-fail states first, then warn states, then ok.
  const base = { expiresAt, expiresInMs, refreshExpiresAt, refreshExpiresInMs, scopes, tokenStatus };

  // (1) Refresh token also dead → must re-login
  if (refreshExpiresInMs !== undefined && refreshExpiresInMs <= 0) {
    return {
      state: 'fail',
      ok: false,
      ...base,
      reason: `lark-cli refresh token expired at ${refreshExpiresAt} — run \`${bin} auth login\` to re-authorize`,
    };
  }

  // (2) Known terminal statuses → fail
  const terminalStatuses = new Set(['expired', 'revoked', 'refresh_expired', 'invalid']);
  if (tokenStatus && terminalStatuses.has(tokenStatus)) {
    return {
      state: 'fail',
      ok: false,
      ...base,
      reason: `lark-cli token status is "${tokenStatus}" — run \`${bin} auth login\` to re-authorize`,
    };
  }

  // (3) needs_refresh + refresh token still valid → WARN (sync will auto-refresh,
  //     no need to bother the user; making this a hard fail was the v0.2.x bug
  //     that misled users into auth login → app-pending-approval dead ends).
  if (tokenStatus === 'needs_refresh') {
    return {
      state: 'warn',
      ok: true,
      ...base,
      reason: refreshExpiresAt
        ? `token needs refresh (sync will auto-refresh next call; refresh token valid until ${refreshExpiresAt})`
        : `token needs refresh (sync will auto-refresh next call)`,
    };
  }

  // (4) Any other unknown non-"valid" tokenStatus → warn but don't fail; user
  //     might be on a newer lark-cli with new states we haven't accounted for.
  if (tokenStatus && tokenStatus !== 'valid') {
    return {
      state: 'warn',
      ok: true,
      ...base,
      reason: `lark-cli reports tokenStatus="${tokenStatus}" — unknown to openapi-lark, allowing through; report at https://github.com/leeguooooo/openapi-lark/issues if sync fails`,
    };
  }

  // (5) Hard expiry on access token (despite tokenStatus=valid). Defensive.
  if (expiresInMs !== undefined && expiresInMs <= 0) {
    return {
      state: 'fail',
      ok: false,
      ...base,
      reason: `lark-cli token expired at ${expiresAt} — run \`${bin} auth login\` to refresh`,
    };
  }
  // (6) tokenStatus=valid and not expired → ok
  return { state: 'ok', ok: true, ...base };
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

export interface AppScopes {
  ok: boolean;
  /** App ID — used to build developer console URLs */
  appId?: string;
  /** "lark" → open.larksuite.com, else open.feishu.cn */
  brand?: string;
  /** Scopes the APP itself has enabled (vs scopes the user has granted) */
  userScopes: string[];
  reason?: string;
}

/**
 * `lark-cli auth scopes` returns the **app-level** scope list (what scopes the
 * app on the Lark developer console has been approved for). This is distinct
 * from `auth check`, which checks the **user-level** token's granted scopes.
 *
 * Why we need both: a missing scope can mean either
 *   (a) user hasn't granted it (fix: `auth login --scope X`), or
 *   (b) app itself doesn't have it (fix: developer console approval)
 * (a) and (b) need different remediation; conflating them sends users on
 * wild-goose chases through `auth login` until they realize the app is the
 * problem. See user feedback in larksuite/cli#1012-context.
 */
export function appScopes(input: { larkBin?: string; env?: NodeJS.ProcessEnv }): AppScopes {
  const bin = input.larkBin ?? 'lark-cli';
  const res = spawnSync(bin, ['auth', 'scopes', '--format', 'json'], {
    encoding: 'utf8',
    env: input.env ?? process.env,
    timeout: 10_000,
  });
  if (res.status !== 0) {
    return {
      ok: false,
      userScopes: [],
      reason: `${bin} auth scopes failed: ${(res.stderr || res.stdout || 'unknown').toString().trim().slice(0, 200)}`,
    };
  }
  // The command prints "Querying app scopes..." to stdout before the JSON,
  // so we have to slice from the first `{`.
  const jsonStart = res.stdout.indexOf('{');
  if (jsonStart < 0) {
    return { ok: false, userScopes: [], reason: 'no JSON in auth scopes output' };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout.slice(jsonStart));
  } catch (err) {
    return { ok: false, userScopes: [], reason: `parse auth scopes: ${(err as Error).message}` };
  }
  return {
    ok: true,
    appId: typeof parsed.appId === 'string' ? parsed.appId : undefined,
    brand: typeof parsed.brand === 'string' ? parsed.brand : undefined,
    userScopes: Array.isArray(parsed.userScopes) ? parsed.userScopes : [],
  };
}

/**
 * Build the Lark developer console URL that lets the user enable a scope on
 * the app side. Mirrors lark-cli's own URL convention (cmd/root.go:413-418).
 */
export function consoleScopeApplyUrl(input: {
  appId: string;
  brand?: string;
  scopes: string[];
}): string {
  const host = input.brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  const scopeParam = encodeURIComponent(input.scopes.join(' '));
  const clientId = encodeURIComponent(input.appId);
  return `https://${host}/page/scope-apply?clientID=${clientId}&scopes=${scopeParam}`;
}

// Update notifier — mirrors lark-cli's internal/update pattern, adapted for
// GitHub-installed packages. Two-tier: synchronous cache check (no I/O) at
// startup, async refresh in background. 24h TTL.
//
// Why this exists: openapi-lark is installed via `npx -y -p github:...` or
// `npm i -g github:...`. Both forms cache aggressively, leaving users on
// stale binaries that miss bug fixes / new features. lark-cli faces the
// same problem and solves it with a startup notice; we mirror their pattern.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const RELEASES_API = 'https://api.github.com/repos/leeguooooo/openapi-lark/releases/latest';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface UpdateInfo {
  current: string;
  latest: string;
}

interface CacheState {
  latestVersion: string;
  checkedAt: number;
}

/**
 * Returns true when the update notifier should be silent for this run.
 *
 * Skips for:
 *  - CI environments (CI / GITHUB_ACTIONS / GITLAB_CI / BUILD_NUMBER / RUN_ID)
 *  - Explicit opt-out: OPENAPI_LARK_NO_UPDATE_NOTIFIER=1
 *  - Dev / unreleased versions ("0.0.0", "dev", "")
 */
export function shouldSkip(version: string): boolean {
  if (process.env.OPENAPI_LARK_NO_UPDATE_NOTIFIER) return true;
  for (const key of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILD_NUMBER', 'RUN_ID']) {
    if (process.env[key]) return true;
  }
  if (!version || version === '0.0.0' || version === 'dev' || version === 'DEV') {
    return true;
  }
  return false;
}

/** Where the cache file lives. Per-user, not per-project. */
function cachePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'openapi-lark', 'update-state.json');
}

function readCache(): CacheState | null {
  try {
    const raw = readFileSync(cachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.latestVersion === 'string' &&
      typeof parsed?.checkedAt === 'number'
    ) {
      return parsed;
    }
  } catch {
    /* missing / unreadable / unparseable → null */
  }
  return null;
}

function writeCache(state: CacheState): void {
  try {
    const p = cachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch {
    /* silent — cache is best-effort */
  }
}

/**
 * Compare two semver-like strings; returns true when `a` is newer than `b`.
 * Strips leading "v". Handles "X.Y.Z" cleanly. For prerelease tags treats
 * them per semver (1.0.0 > 1.0.0-rc.1).
 *
 * Unparseable `a` → false (can't confirm). Unparseable `b` → true (assume
 * remote is newer, mirroring lark-cli's behavior on stale local versions).
 */
export function isNewer(a: string, b: string): boolean {
  const parsed = parseVersion(a);
  if (!parsed) return false;
  const local = parseVersion(b);
  if (!local) return true;
  for (let i = 0; i < 3; i++) {
    if (parsed.core[i] !== local.core[i]) return parsed.core[i] > local.core[i];
  }
  // Equal core. Prerelease < release per semver.
  if (parsed.pre && !local.pre) return false;
  if (!parsed.pre && local.pre) return true;
  if (parsed.pre && local.pre) return parsed.pre > local.pre;
  return false;
}

interface ParsedVersion {
  core: [number, number, number];
  pre: string;
}
function parseVersion(v: string): ParsedVersion | null {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ?? '',
  };
}

/**
 * Synchronously return cached update info if a newer version is known.
 * No network I/O — safe to call on every startup.
 */
export function checkCached(currentVersion: string): UpdateInfo | null {
  if (shouldSkip(currentVersion)) return null;
  const state = readCache();
  if (!state?.latestVersion) return null;
  if (!isNewer(state.latestVersion, currentVersion)) return null;
  return { current: currentVersion, latest: state.latestVersion };
}

/**
 * Fetch latest release from GitHub. No-op if cache is fresh (<24h).
 * Async + best-effort; failures are swallowed so we never block / error
 * the user's actual command.
 */
export async function refreshCache(currentVersion: string): Promise<void> {
  if (shouldSkip(currentVersion)) return;
  const state = readCache();
  if (state && Date.now() - state.checkedAt < CACHE_TTL_MS) return;
  const latest = await fetchLatestRelease();
  if (!latest) return;
  writeCache({ latestVersion: latest, checkedAt: Date.now() });
}

async function fetchLatestRelease(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { tag_name?: string };
      const tag = (data?.tag_name ?? '').replace(/^v/, '');
      return /^\d+\.\d+\.\d+/.test(tag) ? tag : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

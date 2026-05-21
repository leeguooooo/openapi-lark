import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCached, isNewer, refreshCache, shouldSkip } from '../src/update/check.js';

let workdir: string;
let origHome: string | undefined;
let origXdg: string | undefined;
let origCI: string | undefined;
let origNotifier: string | undefined;
let origGha: string | undefined;
let origGl: string | undefined;
let origBn: string | undefined;
let origRid: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'openapi-lark-update-'));
  origHome = process.env.HOME;
  origXdg = process.env.XDG_CONFIG_HOME;
  origCI = process.env.CI;
  origNotifier = process.env.OPENAPI_LARK_NO_UPDATE_NOTIFIER;
  origGha = process.env.GITHUB_ACTIONS;
  origGl = process.env.GITLAB_CI;
  origBn = process.env.BUILD_NUMBER;
  origRid = process.env.RUN_ID;
  process.env.HOME = workdir;
  process.env.XDG_CONFIG_HOME = join(workdir, '.config');
  // Clean every CI / opt-out env so tests have predictable behavior
  delete process.env.CI;
  delete process.env.OPENAPI_LARK_NO_UPDATE_NOTIFIER;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITLAB_CI;
  delete process.env.BUILD_NUMBER;
  delete process.env.RUN_ID;
});

afterEach(() => {
  process.env.HOME = origHome ?? '';
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  if (origCI !== undefined) process.env.CI = origCI;
  if (origNotifier !== undefined) process.env.OPENAPI_LARK_NO_UPDATE_NOTIFIER = origNotifier;
  if (origGha !== undefined) process.env.GITHUB_ACTIONS = origGha;
  if (origGl !== undefined) process.env.GITLAB_CI = origGl;
  if (origBn !== undefined) process.env.BUILD_NUMBER = origBn;
  if (origRid !== undefined) process.env.RUN_ID = origRid;
  rmSync(workdir, { recursive: true, force: true });
});

function writeFakeCache(latest: string, ageMs: number): void {
  const dir = join(workdir, '.config', 'openapi-lark');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'update-state.json'),
    JSON.stringify({ latestVersion: latest, checkedAt: Date.now() - ageMs }),
  );
}

describe('isNewer', () => {
  it('major / minor / patch comparisons', () => {
    expect(isNewer('1.0.0', '0.9.0')).toBe(true);
    expect(isNewer('0.2.0', '0.1.5')).toBe(true);
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });

  it('strips leading v', () => {
    expect(isNewer('v1.0.0', '0.9.0')).toBe(true);
    expect(isNewer('1.0.0', 'v0.9.0')).toBe(true);
  });

  it('prerelease < release', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('unparseable remote → false', () => {
    expect(isNewer('garbage', '0.1.0')).toBe(false);
  });

  it('unparseable local → true (assume outdated)', () => {
    expect(isNewer('0.2.0', 'garbage')).toBe(true);
  });
});

describe('shouldSkip', () => {
  it('skips when notifier disabled', () => {
    process.env.OPENAPI_LARK_NO_UPDATE_NOTIFIER = '1';
    expect(shouldSkip('0.1.0')).toBe(true);
  });
  it('skips in CI', () => {
    process.env.CI = 'true';
    expect(shouldSkip('0.1.0')).toBe(true);
  });
  it('skips in GitHub Actions', () => {
    process.env.GITHUB_ACTIONS = 'true';
    expect(shouldSkip('0.1.0')).toBe(true);
  });
  it('skips empty / dev versions', () => {
    expect(shouldSkip('')).toBe(true);
    expect(shouldSkip('dev')).toBe(true);
    expect(shouldSkip('DEV')).toBe(true);
    expect(shouldSkip('0.0.0')).toBe(true);
  });
  it('allows real versions', () => {
    expect(shouldSkip('0.1.0')).toBe(false);
    expect(shouldSkip('1.2.3')).toBe(false);
  });
});

describe('checkCached', () => {
  it('returns null when no cache', () => {
    expect(checkCached('0.1.0')).toBeNull();
  });

  it('returns update when cache has newer version', () => {
    writeFakeCache('0.2.0', 1000);
    const r = checkCached('0.1.0');
    expect(r).toEqual({ current: '0.1.0', latest: '0.2.0' });
  });

  it('returns null when cached version is older', () => {
    writeFakeCache('0.1.0', 1000);
    expect(checkCached('0.2.0')).toBeNull();
  });

  it('returns null when cached version equals current', () => {
    writeFakeCache('0.1.0', 1000);
    expect(checkCached('0.1.0')).toBeNull();
  });

  it('returns null when shouldSkip', () => {
    writeFakeCache('99.0.0', 1000);
    process.env.OPENAPI_LARK_NO_UPDATE_NOTIFIER = '1';
    expect(checkCached('0.1.0')).toBeNull();
  });
});

describe('refreshCache', () => {
  it('no-op when cache is fresh (<24h)', async () => {
    writeFakeCache('0.1.0', 1000);
    const before = require('node:fs').statSync(
      join(workdir, '.config', 'openapi-lark', 'update-state.json'),
    ).mtimeMs;
    await refreshCache('0.1.0');
    const after = require('node:fs').statSync(
      join(workdir, '.config', 'openapi-lark', 'update-state.json'),
    ).mtimeMs;
    expect(after).toBe(before);
  });

  it('silent when shouldSkip', async () => {
    process.env.OPENAPI_LARK_NO_UPDATE_NOTIFIER = '1';
    await refreshCache('0.1.0');
    // No cache should be written when skip is in effect
    expect(existsSync(join(workdir, '.config', 'openapi-lark', 'update-state.json'))).toBe(false);
  });
});

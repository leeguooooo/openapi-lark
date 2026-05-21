import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import {
  preflight,
  PreflightError,
  authStatus,
  authCheckScopes,
  appScopes,
  consoleScopeApplyUrl,
} from '../src/lark/preflight.js';
import { makeFakeLark, pathWith } from './helpers/fake-lark.js';

let fakeDir: string;

beforeAll(() => {
  fakeDir = makeFakeLark().dir;
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

describe('preflight', () => {
  it('passes when version satisfies range', () => {
    const r = preflight({
      larkBin: 'lark',
      larkCliRange: '>=1.0.0',
      env: {
        PATH: pathWith(fakeDir),
        FAKE_LARK_STDOUT: '1.2.3\n',
        FAKE_LARK_EXIT: '0',
      },
    });
    expect(r.version).toBe('1.2.3');
  });

  it('passes when version contains prefix text', () => {
    const r = preflight({
      larkBin: 'lark',
      larkCliRange: '>=0.1.0',
      env: {
        PATH: pathWith(fakeDir),
        FAKE_LARK_STDOUT: 'lark-cli version 0.2.1 (build abc123)\n',
        FAKE_LARK_EXIT: '0',
      },
    });
    expect(r.version).toBe('0.2.1');
  });

  it('rejects when version too old', () => {
    expect(() =>
      preflight({
        larkBin: 'lark',
        larkCliRange: '>=2.0.0',
        env: {
          PATH: pathWith(fakeDir),
          FAKE_LARK_STDOUT: '1.0.0\n',
          FAKE_LARK_EXIT: '0',
        },
      }),
    ).toThrow(PreflightError);
  });

  it('rejects when lark binary missing (ENOENT)', () => {
    expect(() =>
      preflight({
        larkBin: 'definitely-not-a-binary-xyz',
        larkCliRange: '>=0.0.0',
        env: { PATH: '/usr/nonexistent' },
      }),
    ).toThrow(/not found in PATH/);
  });
});

describe('authStatus', () => {
  it('returns ok with parsed scopes / expiresAt', () => {
    const future = new Date(Date.now() + 24 * 3600_000).toISOString();
    const r = authStatus({
      larkBin: 'lark',
      env: {
        PATH: pathWith(fakeDir),
        FAKE_LARK_STDOUT: JSON.stringify({
          tokenStatus: 'valid',
          expiresAt: future,
          scope: 'wiki:node:read wiki:node:create docx:document:write_only',
        }),
        FAKE_LARK_EXIT: '0',
      },
    });
    expect(r.ok).toBe(true);
    expect(r.scopes).toContain('wiki:node:create');
    expect(r.expiresInMs).toBeGreaterThan(0);
    expect(r.tokenStatus).toBe('valid');
  });

  it('returns ok=false when token expired', () => {
    const past = new Date(Date.now() - 24 * 3600_000).toISOString();
    const r = authStatus({
      larkBin: 'lark',
      env: {
        PATH: pathWith(fakeDir),
        FAKE_LARK_STDOUT: JSON.stringify({ tokenStatus: 'valid', expiresAt: past, scope: '' }),
        FAKE_LARK_EXIT: '0',
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });

  it('returns ok=false when tokenStatus is not valid', () => {
    const r = authStatus({
      larkBin: 'lark',
      env: {
        PATH: pathWith(fakeDir),
        FAKE_LARK_STDOUT: JSON.stringify({ tokenStatus: 'revoked', scope: '' }),
        FAKE_LARK_EXIT: '0',
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/revoked/);
  });
});

describe('authCheckScopes', () => {
  it('parses {ok, granted, missing}', () => {
    const r = authCheckScopes({
      scopes: ['a', 'b'],
      larkBin: 'lark',
      env: {
        PATH: pathWith(fakeDir),
        FAKE_LARK_STDOUT: JSON.stringify({ ok: false, granted: ['a'], missing: ['b'] }),
        FAKE_LARK_EXIT: '0',
      },
    });
    expect(r?.ok).toBe(false);
    expect(r?.granted).toEqual(['a']);
    expect(r?.missing).toEqual(['b']);
  });

  it('returns trivial ok for empty scope list (no API call)', () => {
    const r = authCheckScopes({
      scopes: [],
      larkBin: 'lark',
      env: { PATH: pathWith(fakeDir) },
    });
    expect(r?.ok).toBe(true);
  });

  it('returns null when subcommand unknown (older lark-cli)', () => {
    const r = authCheckScopes({
      scopes: ['a'],
      larkBin: 'lark',
      env: {
        PATH: pathWith(fakeDir),
        FAKE_LARK_STDERR: 'unknown command "check" for "lark auth"\n',
        FAKE_LARK_EXIT: '1',
      },
    });
    expect(r).toBeNull();
  });
});

describe('appScopes', () => {
  it('parses appId / brand / userScopes from real lark-cli output shape', () => {
    // Real shape: "Querying app scopes...\n\n{json}"
    const stdout =
      'Querying app scopes...\n\n' +
      JSON.stringify({
        appId: 'cli_xxx',
        brand: 'lark',
        count: 3,
        tokenType: 'user',
        userScopes: ['wiki:node:read', 'wiki:node:create', 'docx:document:write_only'],
      });
    const r = appScopes({
      larkBin: 'lark',
      env: { PATH: pathWith(fakeDir), FAKE_LARK_STDOUT: stdout, FAKE_LARK_EXIT: '0' },
    });
    expect(r.ok).toBe(true);
    expect(r.appId).toBe('cli_xxx');
    expect(r.brand).toBe('lark');
    expect(r.userScopes).toContain('wiki:node:create');
  });

  it('returns ok=false when lark-cli exits non-zero', () => {
    const r = appScopes({
      larkBin: 'lark',
      env: { PATH: pathWith(fakeDir), FAKE_LARK_STDERR: 'boom\n', FAKE_LARK_EXIT: '1' },
    });
    expect(r.ok).toBe(false);
    expect(r.userScopes).toEqual([]);
    expect(r.reason).toMatch(/auth scopes failed/);
  });
});

describe('consoleScopeApplyUrl', () => {
  it('builds Feishu (default brand) URL', () => {
    const url = consoleScopeApplyUrl({
      appId: 'cli_abc',
      scopes: ['wiki:node:create'],
    });
    expect(url).toBe(
      'https://open.feishu.cn/page/scope-apply?clientID=cli_abc&scopes=wiki%3Anode%3Acreate',
    );
  });

  it('uses Lark Suite host for brand="lark"', () => {
    const url = consoleScopeApplyUrl({
      appId: 'cli_xyz',
      brand: 'lark',
      scopes: ['docx:document:write_only', 'wiki:node:create'],
    });
    expect(url.startsWith('https://open.larksuite.com/page/scope-apply')).toBe(true);
    expect(url).toContain('clientID=cli_xyz');
    // scopes are space-joined then encoded → %20
    expect(url).toContain('docx%3Adocument%3Awrite_only%20wiki%3Anode%3Acreate');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { preflight, PreflightError } from '../src/lark/preflight.js';
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

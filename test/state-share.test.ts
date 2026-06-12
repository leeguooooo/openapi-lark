import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateIgnoredByGit, detectUnsharedState } from '../src/state-share.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'state-share-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gitRunner(status: number | null) {
  return vi.fn().mockReturnValue({ status });
}

describe('stateIgnoredByGit', () => {
  it('true when git check-ignore exits 0 (ignored)', () => {
    const run = gitRunner(0);
    expect(stateIgnoredByGit(dir, run)).toBe(true);
    // Must query a file INSIDE the dir: the stock `.openapi-lark/` ignore
    // entry is directory-only and won't match the bare dir path before the
    // directory exists on disk (the fresh-clone case).
    expect(run).toHaveBeenCalledWith(dir, ['check-ignore', '-q', '.openapi-lark/sync-lock.json']);
  });

  it('false when git check-ignore exits 1 (not ignored)', () => {
    expect(stateIgnoredByGit(dir, gitRunner(1))).toBe(false);
  });

  it('false when not a git repo (exit 128) or git missing (null status)', () => {
    expect(stateIgnoredByGit(dir, gitRunner(128))).toBe(false);
    expect(stateIgnoredByGit(dir, gitRunner(null))).toBe(false);
  });

  it('false when the runner throws (git binary absent)', () => {
    const run = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(stateIgnoredByGit(dir, run)).toBe(false);
  });
});

describe('detectUnsharedState', () => {
  it('warns when no local state exists and the dir is gitignored', () => {
    const r = detectUnsharedState(dir, gitRunner(0));
    expect(r.shouldWarn).toBe(true);
    expect(r.message).toContain('.openapi-lark');
    expect(r.message).toContain('.gitignore');
  });

  it('does not warn when local state already exists (not a fresh clone)', () => {
    mkdirSync(join(dir, '.openapi-lark'), { recursive: true });
    writeFileSync(join(dir, '.openapi-lark', 'sync-lock.json'), '{}');
    const r = detectUnsharedState(dir, gitRunner(0));
    expect(r.shouldWarn).toBe(false);
  });

  it('any state file counts as existing state (node-map.json)', () => {
    mkdirSync(join(dir, '.openapi-lark'), { recursive: true });
    writeFileSync(join(dir, '.openapi-lark', 'node-map.json'), '{}');
    expect(detectUnsharedState(dir, gitRunner(0)).shouldWarn).toBe(false);
  });

  it('any state file counts as existing state (auto-tokens.json)', () => {
    mkdirSync(join(dir, '.openapi-lark'), { recursive: true });
    writeFileSync(join(dir, '.openapi-lark', 'auto-tokens.json'), '{}');
    expect(detectUnsharedState(dir, gitRunner(0)).shouldWarn).toBe(false);
  });

  it('does not warn when state dir is not gitignored (state is shared via git)', () => {
    const r = detectUnsharedState(dir, gitRunner(1));
    expect(r.shouldWarn).toBe(false);
  });

  it('does not warn outside a git repo', () => {
    expect(detectUnsharedState(dir, gitRunner(128)).shouldWarn).toBe(false);
  });
});

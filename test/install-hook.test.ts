import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHookBody,
  composeHookContent,
  stripHookBlock,
  runInstallHook,
} from '../src/commands/install-hook.js';

describe('buildHookBody', () => {
  it('post-commit never exits non-zero', () => {
    const body = buildHookBody('post-commit');
    expect(body).toContain('exit 0');
    expect(body).not.toContain('exit 1');
  });

  it('pre-push exits 1 on sync failure', () => {
    const body = buildHookBody('pre-push');
    expect(body).toContain('exit 1');
  });

  it('both honor OPENAPI_LARK_SKIP_HOOK', () => {
    expect(buildHookBody('post-commit')).toContain('OPENAPI_LARK_SKIP_HOOK');
    expect(buildHookBody('pre-push')).toContain('OPENAPI_LARK_SKIP_HOOK');
  });
});

describe('composeHookContent', () => {
  const block = buildHookBody('post-commit');

  it('creates fresh hook when none exists', () => {
    const out = composeHookContent(null, block);
    expect(out.startsWith('#!/bin/sh')).toBe(true);
    expect(out).toContain(block);
  });

  it('appends to existing user-written hook (preserves their content)', () => {
    const existing = '#!/bin/sh\n# user wrote this\necho "hello"\n';
    const out = composeHookContent(existing, block);
    expect(out).toContain('echo "hello"');
    expect(out).toContain(block);
  });

  it('replaces our block on re-install (idempotent)', () => {
    const first = composeHookContent(null, block);
    const newBlock = buildHookBody('post-commit'); // same kind, same content
    const second = composeHookContent(first, newBlock);
    // Block should appear exactly once
    const occurrences = (second.match(/managed block — do not edit/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

describe('stripHookBlock', () => {
  it('removes our markers + everything between', () => {
    const composed = composeHookContent('#!/bin/sh\necho user-code\n', buildHookBody('post-commit'));
    const stripped = stripHookBlock(composed);
    expect(stripped).toContain('echo user-code');
    expect(stripped).not.toContain('managed block');
    expect(stripped).not.toContain('openapi-lark sync');
  });

  it('no-op when our block not present', () => {
    const input = '#!/bin/sh\necho hi\n';
    expect(stripHookBlock(input)).toBe(input);
  });
});

describe('runInstallHook', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'openapi-lark-hook-'));
    mkdirSync(join(workdir, '.git', 'hooks'), { recursive: true });
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('writes post-commit hook + makes it executable', async () => {
    const code = await runInstallHook({ cwd: workdir, kind: 'post-commit' });
    expect(code).toBe(0);
    const hookPath = join(workdir, '.git', 'hooks', 'post-commit');
    expect(existsSync(hookPath)).toBe(true);
    const mode = statSync(hookPath).mode & 0o777;
    expect(mode & 0o100).toBeTruthy(); // owner execute bit
    expect(readFileSync(hookPath, 'utf8')).toContain('openapi-lark sync');
  });

  it('preserves existing user hook content on install', async () => {
    const hookPath = join(workdir, '.git', 'hooks', 'post-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user-hook"\n', 'utf8');
    await runInstallHook({ cwd: workdir, kind: 'post-commit' });
    const after = readFileSync(hookPath, 'utf8');
    expect(after).toContain('echo "user-hook"');
    expect(after).toContain('managed block');
  });

  it('--uninstall removes only our block', async () => {
    const hookPath = join(workdir, '.git', 'hooks', 'post-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user-hook"\n', 'utf8');
    await runInstallHook({ cwd: workdir, kind: 'post-commit' });
    await runInstallHook({ cwd: workdir, kind: 'post-commit', uninstall: true });
    const after = readFileSync(hookPath, 'utf8');
    expect(after).toContain('echo "user-hook"');
    expect(after).not.toContain('managed block');
  });

  it('returns non-zero when no .git directory', async () => {
    rmSync(join(workdir, '.git'), { recursive: true, force: true });
    const code = await runInstallHook({ cwd: workdir, kind: 'post-commit' });
    expect(code).not.toBe(0);
  });
});

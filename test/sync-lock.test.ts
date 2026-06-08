import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadLock,
  saveLock,
  lookup,
  upsert,
  sha256,
  lockfilePath,
  normalizeMarkdownForHash,
  hashMarkdown,
  toolVersion,
} from '../src/sync-lock.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sync-lock', () => {
  it('returns empty data when lockfile does not exist', () => {
    const data = loadLock(dir);
    expect(data.version).toBe(1);
    expect(data.services).toEqual({});
  });

  it('save then load round-trips', () => {
    const data = loadLock(dir);
    upsert(data, 'voice-room', 'doccnX', {
      sha256: 'a'.repeat(64),
      title: 'GET /x',
      syncedAt: '2026-05-20T00:00:00Z',
    });
    saveLock(dir, data);
    expect(existsSync(lockfilePath(dir))).toBe(true);

    const reloaded = loadLock(dir);
    expect(reloaded.version).toBe(1);
    expect(reloaded.services['voice-room']['doccnX'].sha256).toBe('a'.repeat(64));
  });

  it('lookup returns undefined for missing entry', () => {
    const data = loadLock(dir);
    expect(lookup(data, 'unknown', 'unknown')).toBeUndefined();
  });

  it('treats version mismatch as fresh', () => {
    // Write a raw lockfile with version 99 (bypass saveLock which would force v1)
    const fs = require('node:fs');
    const path = require('node:path');
    const lockPath = lockfilePath(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ version: 99, services: { x: {} } }),
      'utf8',
    );
    const reloaded = loadLock(dir);
    expect(reloaded.version).toBe(1);
    expect(reloaded.services).toEqual({});
  });

  it('treats corrupted JSON as fresh', () => {
    const path = lockfilePath(dir);
    require('node:fs').mkdirSync(require('node:path').dirname(path), { recursive: true });
    require('node:fs').writeFileSync(path, '{broken json', 'utf8');
    const data = loadLock(dir);
    expect(data.services).toEqual({});
  });

  it('sha256 is stable + deterministic', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
    expect(sha256('hello')).not.toBe(sha256('hello!'));
    expect(sha256('hello')).toHaveLength(64);
  });

  it('normalizeMarkdownForHash: strips trailing whitespace per line', () => {
    const a = '# Title\nparagraph    \nfoo\t\n';
    const b = '# Title\nparagraph\nfoo\n';
    expect(normalizeMarkdownForHash(a)).toBe(normalizeMarkdownForHash(b));
  });

  it('normalizeMarkdownForHash: converts CRLF to LF', () => {
    const a = '# Title\r\nbody\r\n';
    const b = '# Title\nbody\n';
    expect(normalizeMarkdownForHash(a)).toBe(normalizeMarkdownForHash(b));
  });

  it('normalizeMarkdownForHash: collapses trailing blank lines', () => {
    const a = '# Title\nbody\n\n\n\n';
    const b = '# Title\nbody\n';
    expect(normalizeMarkdownForHash(a)).toBe(normalizeMarkdownForHash(b));
  });

  it('hashMarkdown: same hash for trivially-different but semantically-equal markdown', () => {
    const a = '# A\nbody    \n\n\n';
    const b = '# A\r\nbody\n';
    expect(hashMarkdown(a)).toBe(hashMarkdown(b));
  });

  it('hashMarkdown: different hash for actually-different content', () => {
    expect(hashMarkdown('# A\nbody\n')).not.toBe(hashMarkdown('# A\nbody2\n'));
  });

  it('hashMarkdown: tool VERSION is part of the key (renderer upgrade re-pushes)', () => {
    // Same markdown, different tool version → different hash, so a renderer-only
    // upgrade (which changes pushed output without changing source markdown)
    // invalidates the cache and triggers a normal re-push.
    const md = '# A\nbody\n';
    expect(hashMarkdown(md, '0.5.1')).not.toBe(hashMarkdown(md, '0.6.0'));
    // Same version → stable.
    expect(hashMarkdown(md, '0.6.0')).toBe(hashMarkdown(md, '0.6.0'));
  });

  it('hashMarkdown: default version override uses the real tool version', () => {
    const md = '# A\nbody\n';
    expect(hashMarkdown(md)).toBe(hashMarkdown(md, toolVersion()));
  });

  it('toolVersion returns a non-empty semver-ish string', () => {
    const v = toolVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('saves with stable key ordering', () => {
    const data = loadLock(dir);
    upsert(data, 'b-service', 'doccnB', {
      sha256: 'b'.repeat(64),
      syncedAt: '2026-05-20T00:00:00Z',
    });
    upsert(data, 'a-service', 'doccnA', {
      sha256: 'a'.repeat(64),
      syncedAt: '2026-05-20T00:00:00Z',
    });
    saveLock(dir, data);
    const raw = readFileSync(lockfilePath(dir), 'utf8');
    const aPos = raw.indexOf('a-service');
    const bPos = raw.indexOf('b-service');
    expect(aPos).toBeLessThan(bPos);
  });
});

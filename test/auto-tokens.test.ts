import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAutoTokens,
  saveAutoTokens,
  lookupAutoToken,
  upsertAutoToken,
  autoTokensPath,
} from '../src/auto-tokens.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auto-tokens-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('auto-tokens', () => {
  it('returns empty data when file does not exist', () => {
    const d = loadAutoTokens(dir);
    expect(d.version).toBe(1);
    expect(d.services).toEqual({});
  });

  it('save then load round-trips', () => {
    const d = loadAutoTokens(dir);
    upsertAutoToken(d, 'admin', {
      docToken: 'auto1',
      createdAt: '2026-05-20T00:00:00Z',
      parentDocToken: 'parent1',
    });
    upsertAutoToken(d, 'game', {
      docToken: 'auto2',
      createdAt: '2026-05-20T00:00:00Z',
      parentDocToken: 'parent1',
    });
    saveAutoTokens(dir, d);
    expect(existsSync(autoTokensPath(dir))).toBe(true);

    const reloaded = loadAutoTokens(dir);
    expect(lookupAutoToken(reloaded, 'admin')?.docToken).toBe('auto1');
    expect(lookupAutoToken(reloaded, 'game')?.docToken).toBe('auto2');
  });

  it('lookup returns undefined for unknown service', () => {
    const d = loadAutoTokens(dir);
    expect(lookupAutoToken(d, 'unknown')).toBeUndefined();
  });

  it('version mismatch yields fresh data', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const p = autoTokensPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 99, services: { x: { docToken: 'y' } } }),
    );
    const d = loadAutoTokens(dir);
    expect(d.services).toEqual({});
  });

  it('corrupted JSON yields fresh data', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const p = autoTokensPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not valid');
    const d = loadAutoTokens(dir);
    expect(d.services).toEqual({});
  });
});

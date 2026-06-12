import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDocTokens } from '../src/commands/resolve-doctokens.js';
import { loadAutoTokens, saveAutoTokens, upsertAutoToken, lookupAutoToken } from '../src/auto-tokens.js';
import type { Config } from '../src/types.js';
import type { WikiChild } from '../src/lark/wiki.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resolve-doctokens-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PARENT = 'parentNode1';

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    engines: { larkCli: '>=1.0.0' },
    services: [{ name: 'demo-api', openapi: 'openapi.yaml', mode: 'endpoint' }],
    pushTimeoutMs: 120_000,
    maxResolvedSizeBytes: 10 * 1024 * 1024,
    maxPushBytes: 1024 * 1024,
    parentDocToken: PARENT,
    ...over,
  } as Config;
}

function mockDeps(children: WikiChild[] = []) {
  return {
    resolveNode: vi.fn().mockReturnValue({
      spaceId: 'space1',
      nodeToken: PARENT,
      objToken: 'objParent',
      objType: 'docx',
      title: 'API 文档',
      parentNodeToken: '',
    }),
    listChildren: vi.fn().mockReturnValue(children),
    createChild: vi.fn().mockImplementation((_space, _parent, title: string) => ({
      nodeToken: `node-${title}`,
      objToken: `obj-${title}`,
      title,
      objType: 'docx',
      hasChild: false,
    })),
  };
}

function child(title: string, nodeToken = `existing-${title}`): WikiChild {
  return { nodeToken, objToken: `obj-${nodeToken}`, title, objType: 'docx', hasChild: false };
}

describe('resolveDocTokens: cross-user reuse (no local auto-tokens cache)', () => {
  it('reuses an existing same-title child instead of creating a duplicate', () => {
    const deps = mockDeps([child('demo-api', 'nodeFromUserA')]);
    const config = makeConfig();

    const stats = resolveDocTokens(dir, config, 'lark-cli', deps);

    expect(deps.createChild).not.toHaveBeenCalled();
    expect(config.services[0].docToken).toBe('nodeFromUserA');
    expect(stats).toEqual({ created: 0, reused: 1, assigned: 1 });
    // persisted so the next run hits the cache without listing
    const auto = loadAutoTokens(dir);
    expect(lookupAutoToken(auto, 'demo-api')?.docToken).toBe('nodeFromUserA');
  });

  it('matches by parentTitle when set (the actual wiki child title)', () => {
    const deps = mockDeps([child('Demo 服务接口', 'nodeFromUserA')]);
    const config = makeConfig({
      services: [
        { name: 'demo-api', openapi: 'openapi.yaml', mode: 'endpoint', parentTitle: 'Demo 服务接口' },
      ] as Config['services'],
    });

    resolveDocTokens(dir, config, 'lark-cli', deps);

    expect(deps.createChild).not.toHaveBeenCalled();
    expect(config.services[0].docToken).toBe('nodeFromUserA');
  });

  it('title match is case-insensitive and trim-insensitive', () => {
    const deps = mockDeps([child('  Demo-API  ', 'nodeFromUserA')]);
    const config = makeConfig();

    resolveDocTokens(dir, config, 'lark-cli', deps);

    expect(deps.createChild).not.toHaveBeenCalled();
    expect(config.services[0].docToken).toBe('nodeFromUserA');
  });

  it('creates a child when no existing title matches', () => {
    const deps = mockDeps([child('unrelated-doc')]);
    const config = makeConfig();

    const stats = resolveDocTokens(dir, config, 'lark-cli', deps);

    expect(deps.createChild).toHaveBeenCalledTimes(1);
    expect(config.services[0].docToken).toBe('node-demo-api');
    expect(stats).toEqual({ created: 1, reused: 0, assigned: 1 });
  });

  it('two services with the same resolved title claim distinct children', () => {
    const deps = mockDeps([child('api', 'n1'), child('api', 'n2')]);
    const config = makeConfig({
      services: [
        { name: 'svc-a', openapi: 'a.yaml', mode: 'endpoint', parentTitle: 'api' },
        { name: 'svc-b', openapi: 'b.yaml', mode: 'endpoint', parentTitle: 'api' },
      ] as Config['services'],
    });

    resolveDocTokens(dir, config, 'lark-cli', deps);

    expect(deps.createChild).not.toHaveBeenCalled();
    const tokens = config.services.map((s) => s.docToken).sort();
    expect(tokens).toEqual(['n1', 'n2']);
  });

  it('falls back to create (current behavior) when listing children fails', () => {
    const deps = mockDeps();
    deps.listChildren.mockImplementation(() => {
      throw new Error('forbidden');
    });
    const config = makeConfig();

    const stats = resolveDocTokens(dir, config, 'lark-cli', deps);

    expect(deps.createChild).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({ created: 1, reused: 0, assigned: 1 });
  });
});

describe('resolveDocTokens: cache behavior (unchanged)', () => {
  it('cache hit skips listing and creation', () => {
    const auto = loadAutoTokens(dir);
    upsertAutoToken(auto, 'demo-api', {
      docToken: 'cachedNode',
      createdAt: '2026-06-01T00:00:00Z',
      parentDocToken: PARENT,
    });
    saveAutoTokens(dir, auto);

    const deps = mockDeps([child('demo-api', 'nodeFromUserA')]);
    const config = makeConfig();

    const stats = resolveDocTokens(dir, config, 'lark-cli', deps);

    expect(deps.listChildren).not.toHaveBeenCalled();
    expect(deps.createChild).not.toHaveBeenCalled();
    expect(config.services[0].docToken).toBe('cachedNode');
    expect(stats).toEqual({ created: 0, reused: 1, assigned: 1 });
  });

  it('explicit docToken services are untouched (no parent resolution at all)', () => {
    const deps = mockDeps();
    const config = makeConfig({
      services: [
        { name: 'demo-api', openapi: 'openapi.yaml', mode: 'endpoint', docToken: 'explicit1' },
      ] as Config['services'],
    });

    const stats = resolveDocTokens(dir, config, 'lark-cli', deps);

    expect(deps.resolveNode).not.toHaveBeenCalled();
    expect(deps.listChildren).not.toHaveBeenCalled();
    expect(stats).toEqual({ created: 0, reused: 0, assigned: 0 });
  });
});

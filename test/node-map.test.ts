import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadNodeMap,
  saveNodeMap,
  nodeMapPath,
  endpointIdentity,
  extractEndpointIdentity,
  getTagNode,
  setTagNode,
  getGroupNode,
  setGroupNode,
  getLeafNode,
  setLeafNode,
} from '../src/node-map.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'node-map-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('node-map: load/save', () => {
  it('returns empty data when file does not exist', () => {
    const d = loadNodeMap(dir);
    expect(d.version).toBe(1);
    expect(d.services).toEqual({});
  });

  it('round-trips all three buckets', () => {
    const d = loadNodeMap(dir);
    setTagNode(d, 'forecast-market-api', 'games', 'node-tag-games');
    setGroupNode(d, 'forecast-market-api', 'games', 'predicts', 'node-grp-pred');
    setLeafNode(
      d,
      'forecast-market-api',
      endpointIdentity('post', '/api/v1/predicts'),
      'node-leaf-create',
    );
    saveNodeMap(dir, d);
    expect(existsSync(nodeMapPath(dir))).toBe(true);

    const reloaded = loadNodeMap(dir);
    expect(getTagNode(reloaded, 'forecast-market-api', 'games')).toBe('node-tag-games');
    expect(getGroupNode(reloaded, 'forecast-market-api', 'games', 'predicts')).toBe(
      'node-grp-pred',
    );
    expect(
      getLeafNode(
        reloaded,
        'forecast-market-api',
        endpointIdentity('POST', '/api/v1/predicts'),
      ),
    ).toBe('node-leaf-create');
  });

  it('lookup returns undefined for unknown keys', () => {
    const d = loadNodeMap(dir);
    expect(getTagNode(d, 'svc', 'missing')).toBeUndefined();
    expect(getGroupNode(d, 'svc', 'tag', 'missing')).toBeUndefined();
    expect(getLeafNode(d, 'svc', 'GET /missing')).toBeUndefined();
  });

  it('version mismatch yields fresh data', () => {
    const p = nodeMapPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 99, services: { x: { tags: {} } } }));
    const d = loadNodeMap(dir);
    expect(d.services).toEqual({});
  });

  it('corrupted JSON yields fresh data', () => {
    const p = nodeMapPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{not valid');
    const d = loadNodeMap(dir);
    expect(d.services).toEqual({});
  });

  it('legacy service entries with missing buckets are auto-filled', () => {
    const p = nodeMapPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        services: { svc: { tags: { a: 'b' } } },
      }),
    );
    const d = loadNodeMap(dir);
    expect(getTagNode(d, 'svc', 'a')).toBe('b');
    expect(getGroupNode(d, 'svc', 'a', 'x')).toBeUndefined();
    expect(getLeafNode(d, 'svc', 'GET /x')).toBeUndefined();
    // Now we can write to the auto-filled buckets without crashing.
    setLeafNode(d, 'svc', 'GET /x', 'leafnode');
    saveNodeMap(dir, d);
    const reloaded = loadNodeMap(dir);
    expect(getLeafNode(reloaded, 'svc', 'GET /x')).toBe('leafnode');
  });

  it('saved file is key-sorted for stable diffs', () => {
    const d = loadNodeMap(dir);
    setLeafNode(d, 'z-svc', 'POST /b', 'n2');
    setLeafNode(d, 'a-svc', 'POST /a', 'n1');
    setLeafNode(d, 'a-svc', 'GET /x', 'n3');
    saveNodeMap(dir, d);
    const raw = require('node:fs').readFileSync(nodeMapPath(dir), 'utf8');
    const idxA = raw.indexOf('a-svc');
    const idxZ = raw.indexOf('z-svc');
    expect(idxA).toBeGreaterThan(0);
    expect(idxA).toBeLessThan(idxZ);
    const idxGet = raw.indexOf('GET /x');
    const idxPost = raw.indexOf('POST /a');
    expect(idxGet).toBeLessThan(idxPost);
  });
});

describe('node-map: endpointIdentity', () => {
  it('uppercases the method and preserves the path', () => {
    expect(endpointIdentity('post', '/api/v1/predicts')).toBe('POST /api/v1/predicts');
    expect(endpointIdentity('GET ', ' /api/v1/x ')).toBe('GET /api/v1/x');
  });

  it('preserves path parameter placeholders', () => {
    expect(endpointIdentity('GET', '/api/users/{id}')).toBe('GET /api/users/{id}');
  });
});

describe('node-map: extractEndpointIdentity', () => {
  it('extracts from "summary — METHOD path" titles', () => {
    expect(extractEndpointIdentity('创建预测（下注） — POST /api/v1/predicts')).toBe(
      'POST /api/v1/predicts',
    );
    expect(extractEndpointIdentity('预测 — POST /api/v1/predicts')).toBe(
      'POST /api/v1/predicts',
    );
  });

  it('extracts from "METHOD path" only', () => {
    expect(extractEndpointIdentity('POST /api/v1/predicts')).toBe(
      'POST /api/v1/predicts',
    );
  });

  it('extracts from mixed-case titles', () => {
    expect(extractEndpointIdentity('Get /api/v1/x')).toBe('GET /api/v1/x');
  });

  it('strips trailing punctuation from inline code', () => {
    expect(extractEndpointIdentity('用户登录接口 `GET /v1/login`')).toBe('GET /v1/login');
  });

  it('returns null when no method/path is present', () => {
    expect(extractEndpointIdentity('随便一个标题')).toBeNull();
    expect(extractEndpointIdentity('CONNECT /weird')).toBeNull(); // not in our verb list
  });
});

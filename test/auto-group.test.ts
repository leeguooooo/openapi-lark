import { describe, it, expect } from 'vitest';
import {
  autoGroupEndpoints,
  longestCommonPathPrefix,
} from '../src/renderer/auto-group.js';

function mk(path: string, method = 'GET'): any {
  return { tagId: 't', method, path, api: {} };
}

describe('longestCommonPathPrefix', () => {
  it('empty input', () => {
    expect(longestCommonPathPrefix([])).toBe('');
  });
  it('shares /api/', () => {
    expect(longestCommonPathPrefix(['/api/a/x', '/api/b/y'])).toBe('/api/');
  });
  it('no shared prefix', () => {
    expect(longestCommonPathPrefix(['/foo', '/bar'])).toBe('');
  });
});

describe('autoGroupEndpoints', () => {
  it('keeps flat when fewer than 8 endpoints', () => {
    const slices = Array.from({ length: 5 }, (_, i) => mk(`/api/voice-room/op${i}`));
    const r = autoGroupEndpoints(slices);
    expect(r.groups).toEqual({});
    expect(r.singletons).toHaveLength(5);
  });

  it('groups when ≥8 endpoints with diverse path prefixes', () => {
    const slices = [
      mk('/api/voice-room/create'),
      mk('/api/voice-room/join'),
      mk('/api/voice-room/list'),
      mk('/api/voice-room/leave'),
      mk('/api/tags/{id}'),
      mk('/api/tags/list'),
      mk('/api/badges/{id}'),
      mk('/api/badges/list'),
      mk('/api/openapi.json'),
    ];
    const r = autoGroupEndpoints(slices);
    expect(Object.keys(r.groups).sort()).toEqual(['badges', 'tags', 'voice-room']);
    expect(r.groups['voice-room']).toHaveLength(4);
    expect(r.groups['tags']).toHaveLength(2);
    expect(r.groups['badges']).toHaveLength(2);
    // openapi.json is a singleton (one endpoint with that segment)
    expect(r.singletons.map((s) => s.path)).toContain('/api/openapi.json');
  });

  it('hoists single-endpoint groups into singletons', () => {
    const slices = [
      mk('/api/voice-room/a'),
      mk('/api/voice-room/b'),
      mk('/api/voice-room/c'),
      mk('/api/voice-room/d'),
      mk('/api/voice-room/e'),
      mk('/api/voice-room/f'),
      mk('/api/voice-room/g'),
      mk('/api/lonely'), // group "lonely" has only 1 → hoisted
    ];
    const r = autoGroupEndpoints(slices);
    // Only "voice-room" group remains (lonely hoisted)
    expect(Object.keys(r.groups)).toEqual([]);
    // Wait — need ≥2 multi-groups, only 1 multi-group → abandon grouping → flat
    expect(r.singletons).toHaveLength(8);
  });

  it('abandons grouping when only 1 multi-endpoint group survives', () => {
    // 10 voice-room endpoints + 1 tags endpoint → only voice-room is multi
    const slices = [
      ...Array.from({ length: 10 }, (_, i) => mk(`/api/voice-room/op${i}`)),
      mk('/api/tags/single'),
    ];
    const r = autoGroupEndpoints(slices);
    expect(r.groups).toEqual({});
    expect(r.singletons).toHaveLength(11);
  });

  it('respects path-parameter segments as ungrouppable', () => {
    const slices = [
      mk('/api/{id}/x'), // first non-prefix segment is path param → singleton
      mk('/api/{id}/y'),
      mk('/api/{id}/z'),
      mk('/api/voice-room/a'),
      mk('/api/voice-room/b'),
      mk('/api/voice-room/c'),
      mk('/api/tags/a'),
      mk('/api/tags/b'),
    ];
    const r = autoGroupEndpoints(slices);
    // {id}/x|y|z → singletons; voice-room (3) and tags (2) → groups
    expect(Object.keys(r.groups).sort()).toEqual(['tags', 'voice-room']);
    expect(r.singletons).toHaveLength(3);
  });
});

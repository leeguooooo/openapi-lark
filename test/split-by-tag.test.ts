import { describe, it, expect } from 'vitest';
import {
  splitByTag,
  titleForTag,
  splitByEndpoint,
  titleForEndpoint,
} from '../src/renderer/split-by-tag.js';

describe('splitByTag', () => {
  const api = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    components: { schemas: {} },
    tags: [{ name: 'room' }, { name: 'gift' }],
    paths: {
      '/rooms': {
        get: { tags: ['room'], operationId: 'listRooms', responses: { '200': {} } },
        post: { tags: ['room'], operationId: 'createRoom', responses: { '201': {} } },
      },
      '/gifts': {
        get: { tags: ['gift'], operationId: 'listGifts', responses: { '200': {} } },
      },
      '/admin/audit': {
        get: { tags: ['admin', 'room'], operationId: 'audit', responses: { '200': {} } },
      },
      '/health': {
        get: { operationId: 'health', responses: { '200': {} } },
      },
    },
  } as const;

  it('groups by first tag', () => {
    const out = splitByTag(api);
    expect(Object.keys(out.byTag).sort()).toEqual(['admin', 'gift', 'room', 'untagged']);
    expect(out.byTag.room.paths['/rooms'].get.operationId).toBe('listRooms');
    expect(out.byTag.room.paths['/rooms'].post.operationId).toBe('createRoom');
    expect(out.byTag.admin.paths['/admin/audit'].get.operationId).toBe('audit');
    expect(out.byTag.untagged.paths['/health'].get.operationId).toBe('health');
  });

  it('overview has paths: {} but keeps info/servers/components', () => {
    const out = splitByTag(api);
    expect(out.overview.paths).toEqual({});
    expect(out.overview.info.title).toBe('T');
    expect(out.overview.servers[0].url).toBe('https://api.example.com');
    expect(out.overview.components).toBeDefined();
  });

  it('does not mutate input api', () => {
    const snapshot = JSON.stringify(api);
    splitByTag(api);
    expect(JSON.stringify(api)).toBe(snapshot);
  });
});

describe('titleForTag', () => {
  const api = {
    tags: [
      { name: 'room', description: '房间管理' },
      { name: 'gift', 'x-display-name': 'Gift Center' },
      { name: 'long', description: 'a'.repeat(40) }, // too long → fallback
    ],
  };
  it('uses alias first when provided', () => {
    expect(titleForTag('room', api, { room: '语音房' })).toBe('语音房');
  });
  it('uses x-display-name when no alias', () => {
    expect(titleForTag('gift', api)).toBe('Gift Center');
  });
  it('uses short description', () => {
    expect(titleForTag('room', api)).toBe('房间管理');
  });
  it('falls back to id for long description', () => {
    expect(titleForTag('long', api)).toBe('long');
  });
  it('falls back to id for unknown tag', () => {
    expect(titleForTag('unknown', api)).toBe('unknown');
  });
});

describe('splitByEndpoint', () => {
  const api = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1.0.0' },
    paths: {
      '/rooms': {
        get: { tags: ['room'], operationId: 'listRooms', summary: 'List rooms', responses: {} },
        post: { tags: ['room'], operationId: 'createRoom', responses: {} },
      },
      '/health': {
        get: { operationId: 'health', responses: {} },
      },
    },
  };

  it('one slice per (path, method)', () => {
    const slices = splitByEndpoint(api);
    expect(slices).toHaveLength(3);
    expect(slices.map((s) => `${s.method} ${s.path}`).sort()).toEqual([
      'GET /health',
      'GET /rooms',
      'POST /rooms',
    ]);
  });

  it('preserves tagId per slice', () => {
    const slices = splitByEndpoint(api);
    expect(slices.find((s) => s.path === '/rooms' && s.method === 'GET')?.tagId).toBe('room');
    expect(slices.find((s) => s.path === '/health')?.tagId).toBe('untagged');
  });

  it('each slice api.paths contains exactly one path with one method', () => {
    const slices = splitByEndpoint(api);
    for (const s of slices) {
      const paths = Object.keys(s.api.paths);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toBe(s.path);
      const methods = Object.keys(s.api.paths[s.path]).filter((k) =>
        ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(k),
      );
      expect(methods).toHaveLength(1);
    }
  });
});

describe('titleForEndpoint', () => {
  it('uses METHOD path when no short summary', () => {
    expect(
      titleForEndpoint({
        tagId: 'room',
        method: 'GET',
        path: '/rooms',
        api: {},
      }),
    ).toBe('GET /rooms');
  });

  it('appends summary if short', () => {
    expect(
      titleForEndpoint({
        tagId: 'room',
        method: 'POST',
        path: '/rooms',
        summary: 'Create room',
        api: {},
      }),
    ).toBe('POST /rooms — Create room');
  });

  it('drops summary if too long', () => {
    const longSummary = 'x'.repeat(50);
    expect(
      titleForEndpoint({
        tagId: 'room',
        method: 'GET',
        path: '/rooms',
        summary: longSummary,
        api: {},
      }),
    ).toBe('GET /rooms');
  });
});

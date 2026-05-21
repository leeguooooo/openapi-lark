// Tests for URL openapi source (chanfana/Hono/FastAPI runtime-fetched specs).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadAndDereference, RenderError } from '../src/renderer/index.js';

const SAMPLE_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Runtime Spec', version: '1.0.0' },
  paths: {
    '/hello': {
      get: { summary: 'hello', responses: { '200': { description: 'ok' } } },
    },
  },
};

let server: Server;
let port: number;
let lastRequest: { url: string; headers: Record<string, string | string[] | undefined> } | null = null;
let respondWith: { status: number; body: string; contentType?: string } = {
  status: 200,
  body: JSON.stringify(SAMPLE_SPEC),
  contentType: 'application/json',
};
let workdir: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastRequest = { url: req.url ?? '', headers: req.headers as Record<string, string> };
    res.statusCode = respondWith.status;
    res.setHeader('content-type', respondWith.contentType ?? 'application/json');
    res.end(respondWith.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'openapi-lark-url-'));
  lastRequest = null;
  respondWith = {
    status: 200,
    body: JSON.stringify(SAMPLE_SPEC),
    contentType: 'application/json',
  };
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('loadAndDereference with URL openapi', () => {
  it('fetches a remote JSON spec and dereferences it', async () => {
    const { api } = await loadAndDereference(
      `http://127.0.0.1:${port}/openapi.json`,
      10 * 1024 * 1024,
    );
    expect((api as any).info.title).toBe('Runtime Spec');
    expect(lastRequest?.url).toBe('/openapi.json');
  });

  it('sends configured headers (Authorization)', async () => {
    await loadAndDereference(
      `http://127.0.0.1:${port}/openapi.json`,
      10 * 1024 * 1024,
      { headers: { Authorization: 'Bearer secret-token' } },
    );
    expect(lastRequest?.headers['authorization']).toBe('Bearer secret-token');
  });

  it('writes openapiSnapshot to disk', async () => {
    const snap = join(workdir, 'api/snap.json');
    await loadAndDereference(
      `http://127.0.0.1:${port}/openapi.json`,
      10 * 1024 * 1024,
      { snapshotAbsPath: snap },
    );
    expect(existsSync(snap)).toBe(true);
    const parsed = JSON.parse(readFileSync(snap, 'utf8'));
    expect(parsed.info.title).toBe('Runtime Spec');
  });

  it('parses YAML response when JSON.parse fails', async () => {
    respondWith = {
      status: 200,
      body:
        'openapi: 3.0.3\n' +
        'info:\n  title: YAML Spec\n  version: 1.0.0\n' +
        'paths: {}\n',
      contentType: 'application/yaml',
    };
    const { api } = await loadAndDereference(
      `http://127.0.0.1:${port}/openapi.yaml`,
      10 * 1024 * 1024,
    );
    expect((api as any).info.title).toBe('YAML Spec');
  });

  it('raises RenderError on HTTP 4xx', async () => {
    respondWith = { status: 401, body: 'unauthorized', contentType: 'text/plain' };
    await expect(
      loadAndDereference(`http://127.0.0.1:${port}/openapi.json`, 10 * 1024 * 1024),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('raises RenderError on fetch timeout', async () => {
    // Use a port nothing listens on to trigger refusal — fast and deterministic
    await expect(
      loadAndDereference('http://127.0.0.1:1/openapi.json', 10 * 1024 * 1024, {
        fetchTimeoutMs: 100,
      }),
    ).rejects.toThrow(RenderError);
  });
});

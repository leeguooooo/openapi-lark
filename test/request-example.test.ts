import { describe, it, expect } from 'vitest';
import { buildCurl, injectRequestExample } from '../src/renderer/request-example.js';

const api = {
  servers: [{ url: 'https://api.example.com' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      BearerAuth: { type: 'http', scheme: 'bearer' },
    },
  },
};

describe('buildCurl', () => {
  it('GET with path param + required query params + apiKey header', () => {
    const op = {
      security: [{ ApiKeyAuth: [] }],
      parameters: [
        { name: 'roomNo', in: 'path', required: true, schema: { type: 'string' }, example: '12345678' },
        { name: 'startTime', in: 'query', required: true, schema: { type: 'integer' }, example: 1704067200 },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 20 } },
      ],
    };
    const curl = buildCurl('get', '/api/admin/voice-room/{roomNo}/presence-records', op, api)!;
    expect(curl).toContain("curl 'https://api.example.com/api/admin/voice-room/12345678/presence-records?startTime=1704067200'");
    expect(curl).toContain("-H 'X-Api-Key: <key>'");
    // optional param NOT included
    expect(curl).not.toContain('limit=');
  });

  it('POST with bearer auth and JSON body', () => {
    const op = {
      security: [{ BearerAuth: [] }],
      requestBody: {
        content: {
          'application/json': {
            schema: { type: 'object', properties: { mobile: { type: 'string', example: '13800000000' } } },
          },
        },
      },
    };
    const curl = buildCurl('post', '/api/login', op, api)!;
    expect(curl).toContain("curl -X POST 'https://api.example.com/api/login'");
    expect(curl).toContain("-H 'Authorization: Bearer <token>'");
    expect(curl).toContain("-H 'Content-Type: application/json'");
    expect(curl).toContain('"mobile":"13800000000"');
  });

  it('no security → no auth header', () => {
    const op = { security: [], parameters: [] };
    const curl = buildCurl('get', '/api/public', op, api)!;
    expect(curl).not.toContain('-H');
  });

  it('falls back to placeholder base url when no servers', () => {
    const curl = buildCurl('get', '/x', { parameters: [] }, { components: {} })!;
    expect(curl).toContain('https://api.example.com/x');
  });
});

describe('injectRequestExample', () => {
  it('inserts 请求示例 before 响应示例', () => {
    const md = `body

### 响应示例 (200)

\`\`\`json
{}
\`\`\``;
    const fullApi = {
      ...api,
      paths: {
        '/api/admin/voice-room/{roomNo}/presence-records': {
          get: {
            security: [{ ApiKeyAuth: [] }],
            parameters: [
              { name: 'roomNo', in: 'path', schema: { type: 'string' }, example: '12345678' },
            ],
          },
        },
      },
    };
    const out = injectRequestExample(md, fullApi);
    expect(out).toContain('### 请求示例');
    expect(out).toContain('```bash');
    expect(out).toContain("-H 'X-Api-Key: <key>'");
    expect(out.indexOf('### 请求示例')).toBeLessThan(out.indexOf('### 响应示例'));
  });
});

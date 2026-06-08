import { describe, it, expect } from 'vitest';
import {
  securitySectionBody,
  injectSecuritySection,
} from '../src/renderer/security-section.js';

const apiKeyApi = {
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  security: [{ BearerAuth: [] }],
};

describe('securitySectionBody', () => {
  it('apiKey-in-header → header instruction', () => {
    const op = { security: [{ ApiKeyAuth: [] }] };
    expect(securitySectionBody(op, apiKeyApi)).toBe('需在请求头携带 `X-Api-Key: <key>`。');
  });

  it('http bearer → Authorization instruction with format', () => {
    const op = { security: [{ BearerAuth: [] }] };
    expect(securitySectionBody(op, apiKeyApi)).toBe(
      '需在 `Authorization: Bearer <token>` 头携带令牌（JWT）。',
    );
  });

  it('operation security:[] → 无需鉴权', () => {
    const op = { security: [] };
    expect(securitySectionBody(op, apiKeyApi)).toBe('无需鉴权。');
  });

  it('falls back to global security when op has none', () => {
    const op = {};
    expect(securitySectionBody(op, apiKeyApi)).toBe(
      '需在 `Authorization: Bearer <token>` 头携带令牌（JWT）。',
    );
  });

  it('no security anywhere → 无需鉴权', () => {
    const op = {};
    expect(securitySectionBody(op, { components: {} })).toBe('无需鉴权。');
  });

  it('multiple requirement objects (OR) listed as options', () => {
    const op = { security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }] };
    const body = securitySectionBody(op, apiKeyApi);
    expect(body).toContain('以下任一方式均可：');
    expect(body).toContain('- 需在请求头携带 `X-Api-Key: <key>`');
    expect(body).toContain('- 需在 `Authorization: Bearer <token>` 头携带令牌（JWT）');
  });

  it('multiple schemes in one object (AND) joined with 且', () => {
    const op = { security: [{ ApiKeyAuth: [], BearerAuth: [] }] };
    expect(securitySectionBody(op, apiKeyApi)).toContain('，且');
  });

  it('apiKey-in-query and basic', () => {
    const api = {
      components: {
        securitySchemes: {
          QueryKey: { type: 'apiKey', in: 'query', name: 'token' },
          Basic: { type: 'http', scheme: 'basic' },
        },
      },
    };
    expect(securitySectionBody({ security: [{ QueryKey: [] }] }, api)).toBe(
      '需在查询参数携带 `token=<key>`。',
    );
    expect(securitySectionBody({ security: [{ Basic: [] }] }, api)).toBe(
      '需在 `Authorization: Basic <base64(user:pass)>` 头携带凭证。',
    );
  });
});

describe('injectSecuritySection', () => {
  it('inserts 鉴权 section after the METHOD/path code line', () => {
    const md = `# Title

\`GET /api/admin/voice-room/{roomNo}/presence-records\`

返回记录流。

### 参数`;
    const api = {
      ...apiKeyApi,
      paths: {
        '/api/admin/voice-room/{roomNo}/presence-records': {
          get: { security: [{ ApiKeyAuth: [] }] },
        },
      },
    };
    const out = injectSecuritySection(md, api);
    expect(out).toContain('### 鉴权');
    expect(out).toContain('需在请求头携带 `X-Api-Key: <key>`');
    // section appears before 参数
    expect(out.indexOf('### 鉴权')).toBeLessThan(out.indexOf('### 参数'));
    // and after the code line
    expect(out.indexOf('GET /api/admin')).toBeLessThan(out.indexOf('### 鉴权'));
  });
});

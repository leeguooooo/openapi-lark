import { describe, it, expect } from 'vitest';
import {
  escapeXmlText,
  inlineToXml,
  buildOverviewCallout,
  buildCallFlow,
  buildPreCallChecklist,
  detectPagination,
  markdownToXml,
} from '../src/renderer/markdown-to-xml.js';

describe('escapeXmlText', () => {
  it('escapes & < > but not quotes', () => {
    expect(escapeXmlText('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
  });
});

describe('inlineToXml', () => {
  it('converts inline code spans', () => {
    expect(inlineToXml('use `X-Api-Key: <key>` header')).toBe(
      'use <code>X-Api-Key: &lt;key&gt;</code> header',
    );
  });

  it('converts bold', () => {
    expect(inlineToXml('a **bold** b')).toBe('a <b>bold</b> b');
  });

  it('converts links and escapes text', () => {
    expect(inlineToXml('[OK](https://x.com/a?b=1) & more')).toBe(
      '<a href="https://x.com/a?b=1">OK</a> &amp; more',
    );
  });
});

const apiSlice = {
  servers: [{ url: 'https://api.example.com' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
  },
  paths: {
    '/api/admin/voice-room/{roomNo}/presence-records': {
      get: {
        operationId: 'getPresence',
        summary: '查询房间用户进出记录（管理端）',
        description: '返回用户进出事件流。\n保留 30 天（TTL）。',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: 'roomNo', in: 'path', schema: { type: 'string' }, example: '12345678' },
        ],
      },
    },
  },
};

describe('buildOverviewCallout', () => {
  it('builds a compact callout with METHOD/path, 鉴权, 用途, note', () => {
    const c = buildOverviewCallout(apiSlice);
    // v0.5.1: callout keeps structure + emoji but NO background-color (Lark
    // strips color attributes on docx import).
    expect(c).toContain('<callout emoji="📌">');
    expect(c).not.toContain('background-color');
    expect(c).toContain('<b>GET /api/admin/voice-room/{roomNo}/presence-records</b>');
    expect(c).toContain('🔑 鉴权：需在请求头携带 <code>X-Api-Key: &lt;key&gt;</code>');
    expect(c).toContain('🎯 用途：查询房间用户进出记录（管理端）');
    expect(c).toContain('⚠️ 注意：保留 30 天（TTL）。');
    expect(c).toContain('</callout>');
  });

  it('returns empty string when no operation', () => {
    expect(buildOverviewCallout({ paths: {} })).toBe('');
  });

  it('omits note when description has no standout hint', () => {
    const c = buildOverviewCallout({
      paths: { '/x': { get: { summary: '简单接口', security: [] } } },
    });
    expect(c).toContain('🎯 用途：简单接口');
    expect(c).not.toContain('⚠️ 注意');
  });
});

// A paginated endpoint (cursor + hasMore + pagination response fields), shaped
// like the real presence-records slice after allOf-flatten.
const paginatedApi = {
  components: {
    securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
  },
  paths: {
    '/api/admin/voice-room/{roomNo}/presence-records': {
      get: {
        operationId: 'getPresence',
        summary: '查询房间用户进出记录（管理端）',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: 'roomNo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'startTime', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'endTime', in: 'query', required: true, schema: { type: 'integer' } },
          {
            name: 'activityType',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['USER_JOINED', 'USER_LEFT', 'USER_KICKED'] },
          },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        activities: { type: 'array', items: { type: 'object' } },
                        pagination: {
                          type: 'object',
                          properties: {
                            hasMore: { type: 'boolean' },
                            nextCursor: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// A simple non-paginated POST create endpoint.
const nonPaginatedApi = {
  components: {
    securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
  },
  security: [{ BearerAuth: [] }],
  paths: {
    '/api/voice-room/create': {
      post: {
        operationId: 'createRoom',
        summary: '创建语音房',
        parameters: [{ name: 'Language', in: 'header', required: false, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { name: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'object' } } },
              },
            },
          },
        },
      },
    },
  },
};

describe('detectPagination', () => {
  it('detects cursor + hasMore + pagination signals', () => {
    const op = paginatedApi.paths['/api/admin/voice-room/{roomNo}/presence-records'].get;
    const pg = detectPagination(op);
    expect(pg.paginated).toBe(true);
    expect(pg.hasCursor).toBe(true);
    expect(pg.hasMore).toBe(true);
  });

  it('detects limit + offset as pagination', () => {
    const op = {
      parameters: [
        { name: 'limit', in: 'query' },
        { name: 'offset', in: 'query' },
      ],
      responses: {},
    };
    expect(detectPagination(op).paginated).toBe(true);
  });

  it('is NOT paginated for a simple create endpoint', () => {
    const op = nonPaginatedApi.paths['/api/voice-room/create'].post;
    expect(detectPagination(op).paginated).toBe(false);
  });
});

describe('buildCallFlow (mermaid whiteboard)', () => {
  it('emits a whiteboard with the actual required params + pagination loop', () => {
    const xml = buildCallFlow(paginatedApi);
    expect(xml).toContain('<h2>调用流程</h2>');
    expect(xml).toContain('<whiteboard type="mermaid">');
    expect(xml).toContain('graph TD');
    // resolved auth step
    expect(xml).toContain('携带 X-Api-Key');
    // actual required param names
    expect(xml).toContain('roomNo / startTime / endTime');
    // optional filter branch from the enum param
    expect(xml).toContain('activityType');
    // pagination decision node + nextCursor loop
    expect(xml).toContain('hasMore = true?');
    expect(xml).toContain('nextCursor');
    // mermaid arrows + decision braces are escaped per Lark rules but structurally present
    expect(xml).toContain('--&gt;');
    expect(xml).toContain('|是|');
    expect(xml).toContain('|否|');
    expect(xml).toContain('</whiteboard>');
  });

  it('emits NOTHING for a non-paginated endpoint (no 2-box noise)', () => {
    expect(buildCallFlow(nonPaginatedApi)).toBe('');
  });

  it('returns empty when no operation', () => {
    expect(buildCallFlow({ paths: {} })).toBe('');
  });
});

describe('buildPreCallChecklist', () => {
  it('emits ≥2 spec-derived checkbox items', () => {
    const xml = buildPreCallChecklist(paginatedApi);
    expect(xml).toContain('<h2>调用前检查</h2>');
    expect(xml).toContain('<checkbox done="false">已配置鉴权：');
    expect(xml).toContain('<checkbox done="false">必填参数已传：roomNo、startTime、endTime</checkbox>');
    expect(xml).toContain('<checkbox done="false">分页：hasMore=true 时用 nextCursor 继续拉取</checkbox>');
    // max 4, all checkboxes
    const count = (xml.match(/<checkbox /g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('skips the whole section when <2 items apply', () => {
    // create endpoint: auth (global bearer) is 1 item; Language not required; not
    // paginated → only 1 item → section skipped.
    expect(buildPreCallChecklist(nonPaginatedApi)).toBe('');
  });

  it('returns empty when no operation', () => {
    expect(buildPreCallChecklist({ paths: {} })).toBe('');
  });
});

describe('markdownToXml — rich blocks', () => {
  const md = `---
title: API
---

\`GET /api/admin/voice-room/{roomNo}/presence-records\`

### 鉴权

需在请求头携带 \`X-Api-Key: <key>\`。

返回用户进出事件流。

<h3 id="x-parameters">参数</h3>

| 名称 | 位置 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|---|
|limit|query|integer|false| 1–100，默认 20 |单页条数|

### 响应

| 状态码 | 含义 | 描述 | Schema |
|---|---|---|---|
|200|[OK](https://x/200)|成功| 见下方响应 Schema |
|400|[Bad Request](https://x/400)|参数错误| 见下方响应 Schema |
|500|[Server Error](https://x/500)|服务异常| 见下方响应 Schema |

### 请求示例

\`\`\`bash
curl 'https://api.example.com/x?a=1&b=2' \\
  -H 'X-Api-Key: <key>'
\`\`\`

### 响应示例 (200)

\`\`\`json
{
  "success": true
}
\`\`\`
`;

  const title = '查询房间用户进出记录（管理端） — GET /api/admin/voice-room/{roomNo}/presence-records';

  it('emits a title block', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain(`<title>${title}</title>`);
  });

  it('injects the top callout right after the title', () => {
    const xml = markdownToXml(md, apiSlice, title);
    const tIdx = xml.indexOf('<title>');
    const cIdx = xml.indexOf('<callout');
    expect(cIdx).toBeGreaterThan(tIdx);
    // callout precedes the first heading/table
    expect(cIdx).toBeLessThan(xml.indexOf('<h3>'));
  });

  it('emits PLAIN table headers (no background-color — Lark strips it)', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain('<th>名称</th>');
    expect(xml).toContain('<th>状态码</th>');
    expect(xml).not.toContain('<th background-color');
  });

  it('emits status codes as plain text (no text-color span — Lark strips it)', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain('<td>200</td>');
    expect(xml).toContain('<td>400</td>');
    expect(xml).toContain('<td>500</td>');
    expect(xml).not.toContain('text-color');
  });

  it('emits NO color attributes anywhere (locks in v0.5.1 cleanup)', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).not.toContain('background-color');
    expect(xml).not.toContain('text-color');
  });

  it('adds captions to the example code blocks', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain('<pre lang="bash" caption="请求示例"><code>');
    expect(xml).toContain('<pre lang="json" caption="响应示例 (200)"><code>');
  });

  it('escapes special chars in code blocks', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain("a=1&amp;b=2");
    expect(xml).toContain("X-Api-Key: &lt;key&gt;");
  });

  it('converts md and html headings', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain('<h3>鉴权</h3>');
    expect(xml).toContain('<h3>参数</h3>');
  });

  it('produces no stray markdown table pipes or fences', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).not.toMatch(/^\|/m);
    expect(xml).not.toContain('```');
  });
});

describe('markdownToXml — v0.6 conditional blocks (end-to-end placement)', () => {
  const md = `# T

\`GET /api/admin/voice-room/{roomNo}/presence-records\`

<h3 id="x">参数</h3>

| 名称 | 位置 |
|---|---|
|roomNo|path|

### 响应

| 状态码 | 含义 |
|---|---|
|200|OK|

### 请求示例

\`\`\`bash
curl x
\`\`\`
`;
  const title = '查询房间用户进出记录（管理端） — GET /presence-records';

  it('injects 调用流程 between 参数 and 响应, and 调用前检查 at the end (paginated)', () => {
    const xml = markdownToXml(md, paginatedApi, title);
    const paramIdx = xml.indexOf('参数');
    const flowIdx = xml.indexOf('<h2>调用流程</h2>');
    const respIdx = xml.indexOf('<h3>响应</h3>');
    const checklistIdx = xml.indexOf('<h2>调用前检查</h2>');
    expect(flowIdx).toBeGreaterThan(-1);
    expect(checklistIdx).toBeGreaterThan(-1);
    // 参数 < 调用流程 < 响应
    expect(paramIdx).toBeLessThan(flowIdx);
    expect(flowIdx).toBeLessThan(respIdx);
    // 调用前检查 is last
    expect(checklistIdx).toBeGreaterThan(respIdx);
    expect(checklistIdx).toBe(Math.max(flowIdx, respIdx, checklistIdx));
    // whiteboard + checkbox survive the transform; still no color attrs
    expect(xml).toContain('<whiteboard type="mermaid">');
    expect(xml).toContain('<checkbox done="false">');
    expect(xml).not.toContain('background-color');
    expect(xml).not.toContain('text-color');
  });

  it('emits NO whiteboard for a non-paginated endpoint, and no/short checklist', () => {
    const xml = markdownToXml(md, nonPaginatedApi, title);
    expect(xml).not.toContain('<whiteboard');
    expect(xml).not.toContain('<h2>调用流程</h2>');
    // create endpoint has <2 derivable checklist items → no checklist either
    expect(xml).not.toContain('<h2>调用前检查</h2>');
  });
});

describe('markdownToXml — robustness (fallback contract)', () => {
  // The caller falls back to the markdown push when markdownToXml throws OR
  // returns empty. These guarantee the function is total on the inputs it sees.
  it('always emits a title even when the body is empty', () => {
    const xml = markdownToXml('', { paths: {} }, 'My Title');
    expect(xml).toContain('<title>My Title</title>');
  });

  it('does not throw on malformed tables / stray html', () => {
    const md = `# T

| broken | row
| no separator |

<div>weird</div>

\`\`\`
unclosed fence`;
    expect(() => markdownToXml(md, { paths: {} }, 'T')).not.toThrow();
  });

  it('handles api without components/security (real endpoint slice shape)', () => {
    // securitySchemes missing → callout 鉴权 falls back gracefully, no throw.
    const api = {
      paths: { '/x': { get: { summary: 's', security: [{ ApiKeyAuth: [] }] } } },
    };
    const xml = markdownToXml('# T\n\nbody', api, 'T');
    expect(xml).toContain('<callout');
    expect(xml).toContain('<title>T</title>');
  });
});

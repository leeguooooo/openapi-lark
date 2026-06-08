import { describe, it, expect } from 'vitest';
import {
  escapeXmlText,
  inlineToXml,
  buildOverviewCallout,
  buildPreCallChecklist,
  detectPagination,
  dottifySchemaRows,
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

describe('dottifySchemaRows (v0.7 »→dotted path)', () => {
  // Schema table header + rows with widdershins `»` depth markers. The 类型 column
  // shows `[object]`/`[xxx]` for arrays.
  const header = ['名称', '类型', '必填', '约束', '描述'];
  const rows = [
    header,
    ['» success', 'boolean', 'true', '', ''],
    ['» data', 'object', 'false', '', ''],
    ['»» activities', '[object]', 'false', '', ''],
    ['»»» activityId', 'string', 'false', '', ''],
    ['»»» seatNumber', 'integer¦null', 'false', '', ''],
    ['»» pagination', 'object', 'false', '', ''],
    ['»»» hasMore', 'boolean', 'false', '', ''],
    ['»»» nextCursor', 'string¦null', 'false', '', ''],
  ];

  it('reconstructs fully-qualified dotted paths with [] on array-of-object parents', () => {
    const out = dottifySchemaRows(rows);
    const names = out.slice(1).map((r) => r[0]);
    expect(names).toEqual([
      'success',
      'data',
      'data.activities[]',
      'data.activities[].activityId',
      'data.activities[].seatNumber',
      'data.pagination',
      'data.pagination.hasMore',
      'data.pagination.nextCursor',
    ]);
    // no » markers remain
    expect(JSON.stringify(out)).not.toContain('»');
  });

  it('leaves non-schema tables (no 名称 header) untouched', () => {
    const other = [
      ['参数', '取值'],
      ['» status', 'normal'],
    ];
    expect(dottifySchemaRows(other)).toEqual(other);
  });

  it('is a no-op when there are no » markers', () => {
    const flat = [header, ['plainField', 'string', 'true', '', 'x']];
    expect(dottifySchemaRows(flat)).toEqual(flat);
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

  it('converts md and html headings (鉴权 dropped for single-scheme — see dedup test)', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain('<h3>参数</h3>');
  });

  it('produces no stray markdown table pipes or fences', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).not.toMatch(/^\|/m);
    expect(xml).not.toContain('```');
  });

  it('v0.7: drops the standalone ### 鉴权 section for single-scheme (callout covers it)', () => {
    const xml = markdownToXml(md, apiSlice, title);
    // exactly one auth mention — the callout's 🔑 line
    expect(xml).toContain('🔑 鉴权：');
    expect(xml).not.toContain('<h3>鉴权</h3>');
    expect((xml.match(/鉴权/g) || []).length).toBe(1);
  });

  it('v0.7: light <hr/> separators between top-level sections', () => {
    const xml = markdownToXml(md, apiSlice, title);
    // sections after the first (参数) get an <hr/> before them: 响应 / 请求示例 / 响应示例
    expect(xml).toContain('<hr/>');
    expect(xml.split('<hr/>').length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe('markdownToXml — v0.7 (no whiteboard, checklist at end, dotted schema)', () => {
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

### 响应 Schema

| 名称 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|
|» data|object|false| | |
|»» activities|[object]|false| | |
|»»» activityId|string|false| | |

### 请求示例

\`\`\`bash
curl x
\`\`\`
`;
  const title = '查询房间用户进出记录（管理端） — GET /presence-records';

  it('emits NO 调用流程 whiteboard (removed in v0.7), checklist at the very end', () => {
    const xml = markdownToXml(md, paginatedApi, title);
    expect(xml).not.toContain('<whiteboard');
    expect(xml).not.toContain('调用流程');
    const checklistIdx = xml.indexOf('<h2>调用前检查</h2>');
    expect(checklistIdx).toBeGreaterThan(-1);
    // checklist is the last major block
    expect(checklistIdx).toBeGreaterThan(xml.indexOf('<h3>响应</h3>'));
    expect(xml).toContain('<checkbox done="false">');
  });

  it('rewrites response-Schema field names to dotted paths through the transform', () => {
    const xml = markdownToXml(md, paginatedApi, title);
    expect(xml).toContain('<td>data.activities[]</td>');
    expect(xml).toContain('<td>data.activities[].activityId</td>');
    expect(xml).not.toContain('»');
  });

  it('emits NO checklist for a <2-item endpoint', () => {
    const xml = markdownToXml(md, nonPaginatedApi, title);
    expect(xml).not.toContain('<h2>调用前检查</h2>');
  });
});

describe('markdownToXml — v0.7 鉴权 dedup (single vs multi scheme)', () => {
  const mdWithAuth = `# T

\`POST /x\`

### 鉴权

以下任一方式均可：
- 需在请求头携带 \`X-Api-Key: <key>\`
- 需在 \`Authorization: Bearer <token>\` 头携带令牌

<h3 id="p">参数</h3>

| 名称 | 位置 |
|---|---|
|a|query|
`;

  const multiSchemeApi = {
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        BearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/x': {
        post: {
          summary: 'multi',
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ name: 'a', in: 'query' }],
        },
      },
    },
  };

  it('KEEPS the standalone 鉴权 section when there are ≥2 OR-options', () => {
    const xml = markdownToXml(mdWithAuth, multiSchemeApi, 'T');
    expect(xml).toContain('<h3>鉴权</h3>');
    expect(xml).toContain('以下任一方式均可');
  });

  it('DROPS the standalone 鉴权 section for a single scheme', () => {
    const singleMd = `# T

\`POST /x\`

### 鉴权

需在请求头携带 \`X-Api-Key: <key>\`。

<h3 id="p">参数</h3>

| 名称 | 位置 |
|---|---|
|a|query|
`;
    const singleApi = {
      components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
      paths: { '/x': { post: { summary: 's', security: [{ ApiKeyAuth: [] }], parameters: [{ name: 'a', in: 'query' }] } } },
    };
    const xml = markdownToXml(singleMd, singleApi, 'T');
    expect(xml).not.toContain('<h3>鉴权</h3>');
    expect(xml).toContain('🔑 鉴权：'); // callout still carries it
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

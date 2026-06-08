import { describe, it, expect } from 'vitest';
import {
  escapeXmlText,
  inlineToXml,
  statusColor,
  buildOverviewCallout,
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

describe('statusColor', () => {
  it('maps status classes', () => {
    expect(statusColor('200')).toBe('green');
    expect(statusColor('204')).toBe('green');
    expect(statusColor('301')).toBe('blue');
    expect(statusColor('400')).toBe('orange');
    expect(statusColor('404')).toBe('orange');
    expect(statusColor('500')).toBe('red');
    expect(statusColor('xyz')).toBeNull();
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
    expect(c).toContain('<callout emoji="📌" background-color="light-blue">');
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

  it('gives table headers a light-gray background', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain('<th background-color="light-gray">名称</th>');
    expect(xml).toContain('<th background-color="light-gray">状态码</th>');
  });

  it('colors status codes by class', () => {
    const xml = markdownToXml(md, apiSlice, title);
    expect(xml).toContain('<span text-color="green">200</span>');
    expect(xml).toContain('<span text-color="orange">400</span>');
    expect(xml).toContain('<span text-color="red">500</span>');
    // non-status table (params) must NOT color its first column
    expect(xml).not.toContain('<span text-color="green">limit</span>');
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

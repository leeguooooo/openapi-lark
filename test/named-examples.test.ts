import { describe, it, expect } from 'vitest';
import { namedExamplesForOperation, requestBodyExampleForOperation } from '../src/renderer/example-from-schema.js';
import { renderWiddershins } from '../src/renderer/widdershins/render.js';
import { markdownToXml } from '../src/renderer/markdown-to-xml.js';

const okSchema = { type: 'object', properties: { code: { type: 'string' }, amount: { type: 'integer' } } };

describe('namedExamplesForOperation', () => {
  it('content.examples 全部返回，带 summary 与状态码', () => {
    const op = { responses: { '200': { content: { 'application/json': { schema: okSchema, examples: {
      金币: { summary: '普通掉落', value: { code: '0', amount: 300 } },
      御守: { value: { code: '0', amount: 0 } },
    } } } } } };
    const ex = namedExamplesForOperation(op);
    expect(ex).toEqual([
      { status: '200', name: '金币', summary: '普通掉落', value: { code: '0', amount: 300 } },
      { status: '200', name: '御守', summary: '', value: { code: '0', amount: 0 } },
    ]);
  });
  it('只有单个 example 时也用作者的，不合成', () => {
    const op = { responses: { '200': { content: { 'application/json': { schema: okSchema, example: { code: '0', amount: 7 } } } } } };
    expect(namedExamplesForOperation(op)).toEqual([{ status: '200', name: '', summary: '', value: { code: '0', amount: 7 } }]);
  });
  it('什么都没写就从 schema 合成一条', () => {
    const op = { responses: { '200': { content: { 'application/json': { schema: okSchema } } } } };
    const ex = namedExamplesForOperation(op);
    expect(ex).toHaveLength(1);
    expect(ex[0].value).toEqual({ code: 'string', amount: 0 });
  });
  it('请求体优先用 content.example', () => {
    const op = { requestBody: { content: { 'application/json': { schema: okSchema, example: { code: 'x' } } } } };
    expect(requestBodyExampleForOperation(op)).toEqual({ example: { code: 'x' } });
  });
});

describe('endpoint 渲染：具名示例每条一节，caption 带标题', async () => {
  const api = {
    openapi: '3.1.0', info: { title: 't', version: '1' },
    paths: { '/roll': { post: {
      summary: '掷骰', responses: { '200': { description: 'ok', content: { 'application/json': { schema: okSchema, examples: {
        金币: { summary: '普通掉落：金币', value: { code: '0', amount: 300 } },
        御守: { summary: '御守 +1', value: { code: '0', amount: 0 } },
      } } } } },
    } } },
  };
  const { markdown } = await renderWiddershins({ api, singleOperationSummary: '掷骰' });
  it('markdown 里两节', () => {
    expect(markdown).toContain('### 响应示例 (200)：金币\n\n普通掉落：金币');
    expect(markdown).toContain('### 响应示例 (200)：御守\n\n御守 +1');
    expect(markdown).toContain('"amount": 300');
    // widdershins 自己渲染的那组裸围栏（> Example responses 之后）必须剥干净：每个示例只出现一次
    expect(markdown.match(/"amount": 300/g)).toHaveLength(1);
    expect(markdown).not.toContain('Example responses');
  });
  it('飞书 XML 的代码块 caption 就是小节标题', () => {
    const xml = markdownToXml(markdown, api);
    expect(xml).toContain('caption="响应示例 (200)：金币');
    expect(xml).toContain('caption="响应示例 (200)：御守');
    expect((xml.match(/<pre /g) || []).length).toBe(2);
  });
});

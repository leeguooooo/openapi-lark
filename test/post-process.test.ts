import { describe, it, expect } from 'vitest';
import {
  escapePipesInTables,
  stripUnsafeHtmlTags,
  postProcess,
  stripWiddershinsBoilerplate,
  stripRootBodyParamRow,
  clearNonePlaceholders,
  localizeHeadings,
  localizeInlineSchemaCell,
  replaceOperationIdHeadings,
} from '../src/renderer/post-process.js';

describe('escapePipesInTables', () => {
  it('escapes | inside table cells', () => {
    const md = `| name | desc |
|------|------|
| foo  | a|b  |
| bar  | x    |`;
    const out = escapePipesInTables(md);
    expect(out).toContain('| foo  | a\\|b  |');
    expect(out).toContain('| bar  | x    |');
  });

  it('does not escape the separator row', () => {
    const md = `| a | b |
|---|---|
| 1 | 2 |`;
    const out = escapePipesInTables(md);
    expect(out).toContain('|---|---|');
  });

  it('leaves non-table content untouched', () => {
    const md = `# title\n\nPipe in text: a | b\n\n\`\`\`\nalso | here\n\`\`\``;
    const out = escapePipesInTables(md);
    expect(out).toBe(md);
  });

  it('does not double-escape already-escaped pipes', () => {
    const md = `| a | b |\n|---|---|\n| 1 | a\\|b |`;
    const out = escapePipesInTables(md);
    expect(out).toContain('| 1 | a\\|b |');
  });

  it('escapes whitespace-bounded pipes when not at column position (codex case)', () => {
    // 2-column table; body row has content "val | more" with whitespace on both sides
    // of the inner pipe. Previous heuristic skipped it (mis-classifying as delimiter);
    // positional algorithm catches it because position doesn't match separator.
    const md = `| col1 | col2     |
|------|----------|
| a    | val | more |`;
    const out = escapePipesInTables(md);
    expect(out).toContain('| a    | val \\| more |');
  });
});

describe('stripUnsafeHtmlTags', () => {
  it('removes <details>, <summary>, <br>, <sub>, <sup>', () => {
    const md = `Text<br>more<sub>x</sub><sup>y</sup>
<details><summary>click</summary>body</details>
end`;
    const out = stripUnsafeHtmlTags(md);
    expect(out).not.toMatch(/<br>|<sub>|<\/sub>|<details>|<summary>|<\/summary>|<sup>|<\/sup>|<\/details>/);
    expect(out).toContain('Text');
    expect(out).toContain('more');
    expect(out).toContain('xy');
    expect(out).toContain('clickbody');
  });

  it('preserves code blocks intact (including html-like content)', () => {
    const md = '```\n<br>preserved<sub>inside</sub>\n```\nafter <br>removed';
    const out = stripUnsafeHtmlTags(md);
    expect(out).toContain('<br>preserved<sub>inside</sub>');
    expect(out).toMatch(/after\s+removed/);
  });

  it('case-insensitive', () => {
    const md = 'a<BR>b<Details>c</DETAILS>d';
    const out = stripUnsafeHtmlTags(md);
    expect(out).toBe('abcd');
  });
});

describe('postProcess', () => {
  it('runs html strip then pipe escape', () => {
    const md = `Para with <br>break.
| col1 | col2 |
|------|------|
| a    | x|y  |`;
    const out = postProcess(md);
    expect(out).not.toContain('<br>');
    expect(out).toContain('| a    | x\\|y  |');
  });
});

describe('stripWiddershinsBoilerplate', () => {
  it('removes "Scroll down for code samples" intro', () => {
    const md = `# API

> Scroll down for code samples, example requests and responses. Select a language from the tabs above.

body`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('Scroll down for code samples');
    expect(out).toContain('body');
  });

  it('removes generator comment', () => {
    const md = `<!-- Generator: Widdershins v4.0.1 -->\n\n# h`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('Widdershins');
  });

  it('removes "Example responses" blockquote', () => {
    const md = `## Responses\n\n> Example responses\n\n> 200 Response`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('Example responses');
  });

  it('removes operation anchor links', () => {
    const md = `## opName\n<a id="opIdgetX"></a>\nbody`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('opIdgetX');
  });

  it('removes empty version-only headings', () => {
    const md = `# Doc\n\n<h2 id="api"> v1.0.0</h2>\n\nbody`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toMatch(/v1\.0\.0<\/h2>/);
    expect(out).toContain('body');
  });

  it('removes tag-level intro heading inside endpoint doc', () => {
    const md = `<h1 id="api--">基础服务</h1>\n\n## op`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('id="api--"');
    expect(out).toContain('## op');
  });

  // Blank-line collapse was moved out of stripWiddershinsBoilerplate to the
  // final stage in postProcess (so collapse runs after ALL transforms).
  it('postProcess collapses 3+ blank lines to 2', () => {
    const out = postProcess(`a\n\n\n\n\nb`);
    expect(out).toBe(`a\n\nb`);
  });

  it('removes "200 Response" callout + following JSON dump', () => {
    const md = `body

> 200 Response

\`\`\`json
{
  "allOf": [{ "type": "object" }]
}
\`\`\`

### 响应`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('200 Response');
    expect(out).not.toContain('"allOf"');
    expect(out).toContain('### 响应');
    expect(out).toContain('body');
  });

  it('removes widdershins auto method__path operation heading (no operationId)', () => {
    const md = `## OTP（applegame）

## post__otp_applegame

\`POST /otp/applegame\`

body`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('post__otp_applegame');
    // tag heading and method/path code span survive
    expect(out).toContain('## OTP（applegame）');
    expect(out).toContain('`POST /otp/applegame`');
    expect(out).toContain('body');
  });

  it('strips method__path heading at various levels and verbs, case-insensitive', () => {
    const md = `# Title
## get__rooms_list
### DELETE__rooms_{id}
#### Patch__a_b_c
keep`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toMatch(/get__rooms_list/);
    expect(out).not.toMatch(/DELETE__rooms/);
    expect(out).not.toMatch(/Patch__a_b_c/);
    expect(out).toContain('# Title');
    expect(out).toContain('keep');
  });

  it('does not strip normal headings or non-verb double-underscore', () => {
    const md = `## 登录接口
## Schemas
## my__custom_section
text`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).toContain('## 登录接口');
    expect(out).toContain('## Schemas');
    // `my` is not an HTTP verb → must be preserved
    expect(out).toContain('## my__custom_section');
  });

  it('full pipeline: H1 title + tag heading preserved, op-id heading gone', () => {
    const md = `# applegame.ai 登录 OTP 发送（独立端点） — POST /otp/applegame

## OTP（applegame）

## post__otp_applegame

\`POST /otp/applegame\`

### Parameters`;
    const out = postProcess(md);
    expect(out).not.toContain('post__otp_applegame');
    expect(out).toContain('# applegame.ai 登录 OTP 发送（独立端点） — POST /otp/applegame');
    expect(out).toContain('## OTP（applegame）');
    expect(out).toContain('### 参数');
    // no triple blank line left behind
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('strips the global "Base URLs:" preamble list', () => {
    const md = `Base URLs:

* <a href="https://api.example.com">https://api.example.com</a>

\`GET /x\``;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('Base URLs:');
    expect(out).not.toContain('api.example.com');
    expect(out).toContain('`GET /x`');
  });

  it('strips the global "# Authentication" section (redundant with per-op 鉴权)', () => {
    const md = `# Authentication

- HTTP Authentication, scheme: bearer

* API Key (ApiKeyAuth)
    - Parameter Name: **X-Api-Key**, in: header.

\`GET /x\``;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('# Authentication');
    expect(out).not.toContain('Parameter Name');
    expect(out).toContain('`GET /x`');
  });

  it('removes multiple status response dumps', () => {
    const md = `> 200 Response

\`\`\`json
{}
\`\`\`

> 400 Response

\`\`\`json
{}
\`\`\`

after`;
    const out = stripWiddershinsBoilerplate(md);
    expect(out).not.toContain('200 Response');
    expect(out).not.toContain('400 Response');
    expect(out).toContain('after');
  });
});

describe('stripRootBodyParamRow', () => {
  it('removes the root body wrapper row but keeps » field rows', () => {
    const md = `| 名称 | 位置 | 类型 | 必填 | 描述 |
|-|-|-|-|-|
| body | body | object | true | none |
| » mobile | body | string | true | 手机号 |
| » code | body | string | true | 验证码 |`;
    const out = stripRootBodyParamRow(md);
    expect(out).not.toMatch(/^\| body \| body \| object/m);
    expect(out).toContain('| » mobile | body | string | true | 手机号 |');
    expect(out).toContain('| » code | body | string | true | 验证码 |');
    // header + separator survive
    expect(out).toContain('| 名称 | 位置 | 类型 | 必填 | 描述 |');
    expect(out).toContain('|-|-|-|-|-|');
  });

  it('matches by cell semantics, not column count (extra 约束 column)', () => {
    const md = `| 名称 | 位置 | 类型 | 必填 | 约束 | 描述 |
|-|-|-|-|-|-|
| body | body | object | true | none | none |
| » mobile | body | string | true | none | 手机号 |`;
    const out = stripRootBodyParamRow(md);
    expect(out).not.toMatch(/^\| body \| body \| object/m);
    expect(out).toContain('| » mobile | body | string | true | none | 手机号 |');
  });

  it('does not remove » body field rows (only the bare root wrapper)', () => {
    const md = `| » body | body | object | false | nested |
| »» inner | body | string | true | x |`;
    const out = stripRootBodyParamRow(md);
    expect(out).toContain('| » body | body | object | false | nested |');
    expect(out).toContain('| »» inner | body | string | true | x |');
  });

  it('leaves array body wrapper rows alone (type array, not object)', () => {
    const md = `| body | body | array | true | none |`;
    const out = stripRootBodyParamRow(md);
    expect(out).toContain('| body | body | array | true | none |');
  });

  it('does not touch a query param literally named body', () => {
    // first cell `body`, but location is `query` not `body` → keep
    const md = `| body | query | string | false | raw body |`;
    const out = stripRootBodyParamRow(md);
    expect(out).toContain('| body | query | string | false | raw body |');
  });
});

describe('clearNonePlaceholders', () => {
  it('clears table cells that are exactly none', () => {
    const md = `| 名称 | 描述 |
|-|-|
| mobile | none |
| code | 验证码 |`;
    const out = clearNonePlaceholders(md);
    expect(out).toContain('| mobile | |');
    expect(out).toContain('| code | 验证码 |');
  });

  it('does not touch prose containing none', () => {
    const md = `This endpoint requires none-of-this and returns none in the body.`;
    const out = clearNonePlaceholders(md);
    expect(out).toBe(md);
  });

  it('does not touch words like none-of-this inside a table cell', () => {
    const md = `| a | none-of-this |\n| b | not none really |`;
    const out = clearNonePlaceholders(md);
    expect(out).toContain('| a | none-of-this |');
    expect(out).toContain('| b | not none really |');
  });

  it('clears multiple none cells in one row', () => {
    const md = `| x | none | none | done |`;
    const out = clearNonePlaceholders(md);
    expect(out).toBe('| x | | | done |');
  });

  it('leaves separator rows untouched', () => {
    const md = `| a | b |\n|-|-|\n| 1 | none |`;
    const out = clearNonePlaceholders(md);
    expect(out).toContain('|-|-|');
    expect(out).toContain('| 1 | |');
  });
});

describe('postProcess table noise integration', () => {
  it('drops root body row and clears none across the full pipeline', () => {
    const md = `### Parameters

| Name | In | Type | Required | Description |
|-|-|-|-|-|
| body | body | object | true | none |
| » mobile | body | string | true | 手机号 |
| » code | body | string | true | none |`;
    const out = postProcess(md);
    // root wrapper gone
    expect(out).not.toMatch(/^\| body \| body \| object/m);
    // header localized + separator kept
    expect(out).toContain('| 名称 | 位置 | 类型 | 必填 | 描述 |');
    expect(out).toContain('|-|-|-|-|-|');
    // field rows kept, none cell blanked
    expect(out).toContain('| » mobile | body | string | true | 手机号 |');
    expect(out).toContain('| » code | body | string | true | |');
    expect(out).not.toMatch(/\| none \|/);
  });
});

describe('localizeHeadings', () => {
  it('translates standard section headings', () => {
    const md = `## Parameters
### Responses
### Response Schema
### Enumerated Values
## Authentication
### Detailed descriptions`;
    const out = localizeHeadings(md);
    expect(out).toContain('## 参数');
    expect(out).toContain('### 响应');
    expect(out).toContain('### 响应 Schema');
    expect(out).toContain('### 枚举值');
    expect(out).toContain('## 鉴权');
    expect(out).toContain('### 详细说明');
    expect(out).not.toMatch(/^## Parameters$/m);
  });

  it('translates standard table headers', () => {
    const md = `| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| x    | q  | str  | true     | x desc      |`;
    const out = localizeHeadings(md);
    expect(out).toContain('| 名称 | 位置 | 类型 | 必填 | 描述 |');
  });

  it('translates status/meaning/schema header', () => {
    const md = `| Status | Meaning | Description | Schema |
|--------|---------|-------------|--------|
| 200    | OK      | ok          | Inline |`;
    const out = localizeHeadings(md);
    expect(out).toContain('| 状态码 | 含义 | 描述 | Schema |');
  });

  it('does not touch user content matching same words elsewhere', () => {
    // "Parameters: X" in prose should NOT become "参数: X"; we only translate
    // line-start heading patterns
    const md = `Some text discussing Parameters and Responses inline.`;
    const out = localizeHeadings(md);
    expect(out).toContain('Parameters and Responses');
  });

  it('localizes the enum table header |Parameter|Value|', () => {
    const md = `#### 枚举值
|Parameter|Value|
|---|---|
|activityType|USER_JOINED|`;
    const out = localizeHeadings(md);
    expect(out).toContain('| 参数 | 取值 |');
    expect(out).not.toContain('|Parameter|Value|');
  });
});

describe('localizeInlineSchemaCell', () => {
  it('replaces Inline with a pointer in the 响应 table', () => {
    const md = `| 状态码 | 含义 | 描述 | Schema |
|---|---|---|---|
|200|OK|成功|Inline|
|400|Bad Request|参数错误|Inline|`;
    const out = localizeInlineSchemaCell(md);
    expect(out).toContain('|200|OK|成功| 见下方响应 Schema |');
    expect(out).toContain('|400|Bad Request|参数错误| 见下方响应 Schema |');
    expect(out).not.toContain('|Inline|');
  });

  it('only touches the 响应 table, not other Inline text', () => {
    const md = `Some Inline text here.

| 名称 | 类型 |
|---|---|
|x|Inline|`;
    const out = localizeInlineSchemaCell(md);
    expect(out).toContain('Some Inline text here.');
    expect(out).toContain('|x|Inline|');
  });
});

describe('replaceOperationIdHeadings', () => {
  it('replaces ## <operationId> with ## <summary>', () => {
    const md = `## getOpenAPISpec\n\nbody\n\n## getRoomConfig\n\nbody2`;
    const api = {
      paths: {
        '/x': {
          get: { operationId: 'getOpenAPISpec', summary: '获取OpenAPI规范' },
        },
        '/y': {
          get: { operationId: 'getRoomConfig', summary: '获取房间配置' },
        },
      },
    };
    const out = replaceOperationIdHeadings(md, api);
    expect(out).toContain('## 获取OpenAPI规范');
    expect(out).toContain('## 获取房间配置');
    expect(out).not.toContain('## getOpenAPISpec');
  });

  it('leaves operationId headings without summary intact', () => {
    const md = `## someId\nbody`;
    const api = {
      paths: { '/x': { get: { operationId: 'someId' } } },
    };
    const out = replaceOperationIdHeadings(md, api);
    expect(out).toContain('## someId');
  });

  it('does not touch unrelated headings', () => {
    const md = `## 已经是中文\n## Schemas`;
    const api = { paths: {} };
    const out = replaceOperationIdHeadings(md, api);
    expect(out).toContain('## 已经是中文');
    expect(out).toContain('## Schemas');
  });
});

describe('post-process integration with api', () => {
  it('replaces operationIds when api is passed', () => {
    const md = `## getX\n\n> Scroll down for code samples, example requests and responses.\n\n### Parameters`;
    const api = {
      paths: { '/x': { get: { operationId: 'getX', summary: '获取 X' } } },
    };
    const out = postProcess(md, api);
    expect(out).toContain('## 获取 X');
    expect(out).toContain('### 参数');
    expect(out).not.toContain('Scroll down');
  });
});

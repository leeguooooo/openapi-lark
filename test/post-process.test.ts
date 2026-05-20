import { describe, it, expect } from 'vitest';
import {
  escapePipesInTables,
  stripUnsafeHtmlTags,
  postProcess,
  stripWiddershinsBoilerplate,
  localizeHeadings,
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

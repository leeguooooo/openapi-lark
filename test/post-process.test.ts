import { describe, it, expect } from 'vitest';
import {
  escapePipesInTables,
  stripUnsafeHtmlTags,
  postProcess,
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

import { describe, it, expect } from 'vitest';
import { lockTitleInMarkdown } from '../src/commands/sync-tree.js';

describe('lockTitleInMarkdown', () => {
  it('strips front-matter, demotes existing H1s, and prepends new H1', () => {
    const md = `---
title: foo
language_tabs:
  - curl: curl
---

# Authentication

# Section

para
`;
    const out = lockTitleInMarkdown(md, '基础服务');
    expect(out.startsWith('# 基础服务\n\n')).toBe(true);
    expect(out).not.toContain('language_tabs:');
    expect(out).not.toMatch(/^# Authentication/m);
    expect(out).toMatch(/^## Authentication/m);
    expect(out).toMatch(/^## Section/m);
    // EXACTLY one H1 line in the entire output
    const h1Count = out.split('\n').filter((l) => /^# (?!#)/.test(l)).length;
    expect(h1Count).toBe(1);
  });

  it('demotes <h1> HTML tags too', () => {
    const md = `<h1 id="x">Big</h1>\npara`;
    const out = lockTitleInMarkdown(md, 'T');
    expect(out).toContain('<h2 id="x">Big</h2>');
    expect(out).not.toContain('<h1');
  });

  it('preserves content inside fenced code blocks', () => {
    const md = '```\n# this looks like H1 but is code\n```\n# real H1';
    const out = lockTitleInMarkdown(md, 'T');
    expect(out).toContain('# this looks like H1 but is code');
    expect(out).toMatch(/^## real H1$/m);
    const h1Count = out.split('\n').filter((l) => /^# (?!#)/.test(l)).length;
    expect(h1Count).toBe(1);
  });

  it('no front-matter still works', () => {
    const md = `# original\nbody`;
    const out = lockTitleInMarkdown(md, 'New');
    expect(out.startsWith('# New\n\n')).toBe(true);
    expect(out).toContain('## original');
  });
});

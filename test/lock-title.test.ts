import { describe, it, expect } from 'vitest';
import { lockTitleInMarkdown } from '../src/commands/sync-tree.js';

describe('lockTitleInMarkdown', () => {
  it('replaces existing title: in widdershins front-matter', () => {
    const md = `---
title: 语音房服务 API v1.0.0
language_tabs:
  - curl: curl
---

# Authentication
body
`;
    const out = lockTitleInMarkdown(md, '基础服务');
    expect(out).toContain('title: "基础服务"');
    expect(out).not.toContain('title: 语音房服务');
    expect(out).toContain('language_tabs:');
    expect(out).toContain('# Authentication');
  });

  it('injects minimal front-matter when none exists', () => {
    const md = `# heading\n\nbody`;
    const out = lockTitleInMarkdown(md, '新标题');
    expect(out.startsWith('---\ntitle: "新标题"\n---')).toBe(true);
    expect(out).toContain('# heading');
  });

  it('inserts title: into front-matter that has no existing title', () => {
    const md = `---\nlanguage_tabs: []\n---\n\nbody`;
    const out = lockTitleInMarkdown(md, 'X');
    expect(out).toMatch(/^---\ntitle: "X"\nlanguage_tabs: \[\]\n---/);
  });

  it('escapes double quotes in title', () => {
    const md = `# x\nbody`;
    const out = lockTitleInMarkdown(md, 'My "Quoted" Title');
    expect(out).toContain('title: "My \\"Quoted\\" Title"');
  });
});

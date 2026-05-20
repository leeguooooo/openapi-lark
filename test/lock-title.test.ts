import { describe, it, expect } from 'vitest';
import { lockTitleInMarkdown } from '../src/commands/sync-tree.js';

describe('lockTitleInMarkdown', () => {
  it('strips widdershins YAML front-matter and prepends new H1', () => {
    const md = `---
title: 语音房服务 API v1.0.0
language_tabs:
  - curl: curl
---

<h1 id="-api">语音房服务 API v1.0.0</h1>

> intro

# Authentication

- bearer
`;
    const out = lockTitleInMarkdown(md, '基础服务');
    expect(out.startsWith('# 基础服务\n')).toBe(true);
    expect(out).not.toContain('language_tabs');
    expect(out).not.toContain('title: 语音房服务');
    expect(out).toContain('<h1 id="-api">语音房服务 API v1.0.0</h1>');
  });

  it('works with no front-matter', () => {
    const md = `# 原标题\n\nbody`;
    const out = lockTitleInMarkdown(md, '新标题');
    expect(out.split('\n')[0]).toBe('# 新标题');
    expect(out).toContain('# 原标题');
  });

  it('handles empty body after front-matter', () => {
    const md = `---\nfoo: bar\n---\n`;
    const out = lockTitleInMarkdown(md, 'X');
    expect(out).toBe('# X\n\n');
  });

  it('does not treat lone --- as front-matter', () => {
    const md = `---\n\nbody without close`;
    const out = lockTitleInMarkdown(md, 'X');
    expect(out.startsWith('# X\n\n---')).toBe(true);
  });
});

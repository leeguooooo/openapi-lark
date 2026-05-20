import { describe, it, expect } from 'vitest';
import { lockTitleInMarkdown } from '../src/commands/sync-tree.js';

describe('lockTitleInMarkdown', () => {
  it('keeps front-matter and prepends # H1 as the first body line', () => {
    const md = `---
title: 语音房服务 API v1.0.0
language_tabs:
  - curl: curl
---

# Authentication

body
`;
    const out = lockTitleInMarkdown(md, '基础服务');
    expect(out).toContain('language_tabs:');
    // The first body H1 after front-matter must be our title
    const afterFm = out.split('\n---\n').slice(1).join('\n---\n').trim();
    expect(afterFm.split('\n')[0]).toBe('# 基础服务');
  });

  it('prepends # H1 when there is no front-matter', () => {
    const md = `# heading\nbody`;
    const out = lockTitleInMarkdown(md, '新标题');
    expect(out.startsWith('# 新标题\n')).toBe(true);
    expect(out).toContain('# heading');
  });

  it('handles empty body', () => {
    const md = `---\nfoo: bar\n---\n`;
    const out = lockTitleInMarkdown(md, 'X');
    expect(out).toContain('---');
    expect(out).toContain('# X');
  });
});

import { describe, it, expect } from 'vitest';
import { extractDocToken } from '../src/commands/init.js';

describe('extractDocToken', () => {
  it('extracts from feishu.cn /docx/', () => {
    expect(extractDocToken('https://feishu.cn/docx/doccnABC123')).toBe('doccnABC123');
  });
  it('extracts from feishu.cn /wiki/', () => {
    expect(extractDocToken('https://feishu.cn/wiki/wikXYZ')).toBe('wikXYZ');
  });
  it('extracts from larksuite.com /docx/', () => {
    expect(extractDocToken('https://a.larksuite.com/docx/abc')).toBe('abc');
  });
  it('extracts from larkoffice.com /docs/', () => {
    expect(extractDocToken('https://x.larkoffice.com/docs/123tok')).toBe('123tok');
  });
  it('strips query and fragment', () => {
    expect(
      extractDocToken('https://feishu.cn/docx/abc123?from=mobile#section'),
    ).toBe('abc123');
  });
  it('returns null for non-feishu host', () => {
    expect(extractDocToken('https://example.com/docx/abc')).toBeNull();
  });
  it('returns null for malformed url', () => {
    expect(extractDocToken('not-a-url')).toBeNull();
  });
  it('returns null when no known segment marker', () => {
    expect(extractDocToken('https://feishu.cn/random/path')).toBeNull();
  });
});

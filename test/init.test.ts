import { describe, it, expect } from 'vitest';
import { extractDocToken } from '../src/commands/init.js';

describe('extractDocToken', () => {
  it('extracts from feishu.cn /docx/', () => {
    expect(extractDocToken('https://feishu.cn/docx/doccnABC123')).toBe('doccnABC123');
  });
  it('extracts from feishu.cn /wiki/', () => {
    expect(extractDocToken('https://feishu.cn/wiki/wikXYZ1234')).toBe('wikXYZ1234');
  });
  it('extracts from larksuite.com /docx/', () => {
    expect(extractDocToken('https://a.larksuite.com/docx/abcDEF1234')).toBe('abcDEF1234');
  });
  it('extracts from larkoffice.com /docs/', () => {
    expect(extractDocToken('https://x.larkoffice.com/docs/doc123token')).toBe(
      'doc123token',
    );
  });
  it('strips query and fragment', () => {
    expect(
      extractDocToken('https://feishu.cn/docx/abc12345?from=mobile#section'),
    ).toBe('abc12345');
  });
  it('returns null for non-feishu host', () => {
    expect(extractDocToken('https://example.com/docx/abc')).toBeNull();
  });
  it('returns null for malformed url', () => {
    expect(extractDocToken('not-a-url')).toBeNull();
  });
  it('returns null when token shape invalid (too short)', () => {
    expect(extractDocToken('https://feishu.cn/docx/abc')).toBeNull();
  });

  it('falls back to last segment for unknown markers on trusted host', () => {
    expect(extractDocToken('https://feishu.cn/minutes/mtABCDEFGH123')).toBe(
      'mtABCDEFGH123',
    );
  });

  it('rejects fallback when last segment fails shape check', () => {
    expect(extractDocToken('https://feishu.cn/random/!@#$')).toBeNull();
  });

  it('returns null for single-segment path', () => {
    expect(extractDocToken('https://feishu.cn/home')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { parsePushOutput } from '../src/lark/parse-output.js';

describe('parsePushOutput', () => {
  it('extracts url from --json mode (top-level url)', () => {
    const r = parsePushOutput('{"url":"https://feishu.cn/docx/abc123"}');
    expect(r.url).toBe('https://feishu.cn/docx/abc123');
    expect(r.jsonMode).toBe(true);
  });

  it('extracts url from --json mode (data.docUrl)', () => {
    const r = parsePushOutput(
      JSON.stringify({ data: { docUrl: 'https://abc.larksuite.com/docx/xyz' } }),
    );
    expect(r.url).toBe('https://abc.larksuite.com/docx/xyz');
    expect(r.jsonMode).toBe(true);
  });

  it('extracts url via regex fallback when stdout is plain text', () => {
    const r = parsePushOutput(
      'Updated successfully. View at https://feishu.cn/docx/xxxxxxx\n',
    );
    expect(r.url).toBe('https://feishu.cn/docx/xxxxxxx');
    expect(r.jsonMode).toBe(false);
  });

  it('returns null when no url is found', () => {
    const r = parsePushOutput('ok\n');
    expect(r.url).toBeNull();
    expect(r.jsonMode).toBe(false);
  });

  it('handles malformed JSON gracefully (falls back to regex)', () => {
    const r = parsePushOutput('{"url": broken json. https://feishu.cn/docx/aaa');
    expect(r.url).toBe('https://feishu.cn/docx/aaa');
    expect(r.jsonMode).toBe(false);
  });

  it('finds url nested deeply in JSON', () => {
    const r = parsePushOutput(
      JSON.stringify({ result: { meta: { link: 'https://feishu.cn/wiki/deep' } } }),
    );
    expect(r.url).toBe('https://feishu.cn/wiki/deep');
    expect(r.jsonMode).toBe(true);
  });
});

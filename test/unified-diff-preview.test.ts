import { describe, it, expect } from 'vitest';
import { unifiedDiffPreview } from '../src/commands/sync-endpoint.js';

describe('unifiedDiffPreview', () => {
  it('marks added lines with +', () => {
    const out = unifiedDiffPreview('a\nb\n', 'a\nb\nc\n', 10);
    expect(out).toContain('+ c');
  });

  it('marks removed lines with -', () => {
    const out = unifiedDiffPreview('a\nb\nc\n', 'a\nb\n', 10);
    expect(out).toContain('- c');
  });

  it('returns placeholder when sets are identical (whitespace-only style diffs)', () => {
    const out = unifiedDiffPreview('a\nb\n', 'b\na\n', 10);
    // Same SET of lines (just reordered) → no per-line diff captured
    expect(out).toContain('no line-level diff');
  });

  it('honors maxLines cap', () => {
    const a = '';
    const b = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const out = unifiedDiffPreview(a, b, 5);
    const adds = out.split('\n').filter((l) => l.includes('+ '));
    expect(adds.length).toBeLessThanOrEqual(5);
  });
});

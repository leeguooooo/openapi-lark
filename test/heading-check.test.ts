import { describe, it, expect } from 'vitest';
import { detectHeadingJumps, groupHeadingWarnings } from '../src/renderer/heading-check.js';

describe('detectHeadingJumps', () => {
  it('warns on H2 → H4 jump', () => {
    const md = `# title
## section
#### deeply
`;
    const warnings = detectHeadingJumps(md);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ from: 2, to: 4 });
    expect(warnings[0].text).toContain('deeply');
  });

  it('no warning on continuous descent H1 → H2 → H3', () => {
    const md = `# a
## b
### c
`;
    expect(detectHeadingJumps(md)).toHaveLength(0);
  });

  it('no warning on ascending levels', () => {
    const md = `### c
## b
# a
`;
    expect(detectHeadingJumps(md)).toHaveLength(0);
  });

  it('warns on multiple jumps', () => {
    const md = `## a
#### b
## c
###### d
`;
    const warnings = detectHeadingJumps(md);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({ from: 2, to: 4 });
    expect(warnings[1]).toMatchObject({ from: 2, to: 6 });
  });

  it('handles empty markdown', () => {
    expect(detectHeadingJumps('')).toHaveLength(0);
  });

  it('handles markdown with only paragraphs', () => {
    expect(detectHeadingJumps('hello world\n\nno headings here\n')).toHaveLength(0);
  });
});

describe('groupHeadingWarnings', () => {
  it('groups identical (from, to, text) into a single bucket with count', () => {
    const warnings = [
      { from: 2, to: 4, line: 10, text: 'Enumerated Values' },
      { from: 2, to: 4, line: 20, text: 'Enumerated Values' },
      { from: 2, to: 4, line: 30, text: 'Enumerated Values' },
      { from: 2, to: 4, line: 40, text: 'Enumerated Values' },
      { from: 1, to: 3, line: 50, text: 'Properties' },
    ];
    const grouped = groupHeadingWarnings(warnings);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({
      from: 2,
      to: 4,
      pattern: 'Enumerated Values',
      count: 4,
    });
    expect(grouped[0].sampleLines).toEqual([10, 20, 30]); // first 3 only
    expect(grouped[1]).toMatchObject({ pattern: 'Properties', count: 1 });
  });

  it('returns empty for empty input', () => {
    expect(groupHeadingWarnings([])).toEqual([]);
  });

  it('orders groups by count descending', () => {
    const warnings = [
      { from: 1, to: 2, line: 1, text: 'rare' },
      { from: 2, to: 4, line: 2, text: 'common' },
      { from: 2, to: 4, line: 3, text: 'common' },
      { from: 2, to: 4, line: 4, text: 'common' },
    ];
    const grouped = groupHeadingWarnings(warnings);
    expect(grouped[0].pattern).toBe('common');
    expect(grouped[1].pattern).toBe('rare');
  });
});

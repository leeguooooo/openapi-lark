import { describe, it, expect } from 'vitest';
import { detectHeadingJumps } from '../src/renderer/heading-check.js';

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

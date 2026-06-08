import { describe, it, expect } from 'vitest';
import { formatProgress } from '../src/report.js';

describe('formatProgress', () => {
  it('formats [i/n] p% with rounded percentage', () => {
    expect(formatProgress(42, 175)).toBe('[42/175] 24%');
    expect(formatProgress(1, 161)).toBe('[1/161] 1%');
    expect(formatProgress(161, 161)).toBe('[161/161] 100%');
  });

  it('rounds to nearest integer percent', () => {
    // 1/3 = 33.33% → 33
    expect(formatProgress(1, 3)).toBe('[1/3] 33%');
    // 2/3 = 66.66% → 67
    expect(formatProgress(2, 3)).toBe('[2/3] 67%');
  });

  it('guards a zero total (never divides by zero)', () => {
    expect(formatProgress(0, 0)).toBe('[0/0] 0%');
  });
});

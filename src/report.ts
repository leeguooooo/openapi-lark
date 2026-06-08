import type { ServiceResult } from './types.js';

/**
 * Format a per-item progress prefix like `[42/175] 24%`.
 *
 * - `i` is 1-based (the item just completed).
 * - Percentage is rounded to the nearest integer.
 * - Guards a zero/negative total → `[i/0] 0%` (never divides by zero).
 */
export function formatProgress(i: number, n: number): string {
  const pct = n > 0 ? Math.round((i / n) * 100) : 0;
  return `[${i}/${n}] ${pct}%`;
}

const STATUS_SYMBOL: Record<ServiceResult['status'], string> = {
  ok: '✓',
  failed: '✗',
  warning: '⚠',
  skipped: '·',
};

function padRight(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len - 1) + '…'.slice(0) : s + ' '.repeat(len - s.length);
}

function padCenter(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  const left = Math.floor((len - s.length) / 2);
  const right = len - s.length - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
}

export function renderSummaryTable(results: ServiceResult[]): string {
  const nameW = Math.max(7, ...results.map((r) => r.service.length));
  const statW = 7;
  const docW = Math.max(20, ...results.map((r) => (r.docUrl ?? r.reason ?? '-').length));
  const durW = 9;

  const sep = `+${'-'.repeat(nameW + 2)}+${'-'.repeat(statW + 2)}+${'-'.repeat(docW + 2)}+${'-'.repeat(durW + 2)}+`;
  const lines: string[] = [];
  lines.push(sep);
  lines.push(
    `| ${padRight('service', nameW)} | ${padRight('status', statW)} | ${padRight('doc', docW)} | ${padRight('duration', durW)} |`,
  );
  lines.push(sep);
  for (const r of results) {
    const status = `${STATUS_SYMBOL[r.status]} ${r.status}`;
    const docOrReason = r.docUrl ?? r.reason ?? '-';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    lines.push(
      `| ${padRight(r.service, nameW)} | ${padRight(status, statW)} | ${padRight(docOrReason, docW)} | ${padRight(dur, durW)} |`,
    );
  }
  lines.push(sep);
  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const warn = results.filter((r) => r.status === 'warning').length;
  const skip = results.filter((r) => r.status === 'skipped').length;
  lines.push(
    `${ok} ok / ${failed} failed / ${warn} warning / ${skip} skipped`,
  );
  void padCenter; // unused for now; kept for future
  return lines.join('\n');
}

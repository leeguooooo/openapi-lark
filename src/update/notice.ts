// Notice formatting + emission. Kept tiny so callers can wire it into any
// exit path (process.on('exit'), top-level finally, etc.) without surprises.

import type { UpdateInfo } from './check.js';

/**
 * One-line notice formatted for stderr. Two install paths covered so the
 * user can pick whichever fits their setup:
 *
 *   npm i -g github:leeguooooo/openapi-lark   (re-pulls main HEAD)
 *   rm -rf ~/.npm/_npx                        (clears npx cache; next run refreshes)
 */
export function formatNotice(info: UpdateInfo): string {
  const lines = [
    `[openapi-lark] v${info.latest} available (current ${info.current})`,
    `  update: npm i -g github:leeguooooo/openapi-lark`,
    `  or:     rm -rf ~/.npm/_npx   # clears npx cache for next run`,
    `  silence: export OPENAPI_LARK_NO_UPDATE_NOTIFIER=1`,
  ];
  return lines.join('\n');
}

let pending: UpdateInfo | null = null;
let printed = false;

export function setPendingNotice(info: UpdateInfo | null): void {
  pending = info;
}

export function getPendingNotice(): UpdateInfo | null {
  return pending;
}

/**
 * Print the notice to stderr exactly once. Idempotent — safe to wire into
 * process.on('exit') and a top-level finally; only the first call prints.
 */
export function emitNoticeOnce(): void {
  if (printed || !pending) return;
  printed = true;
  process.stderr.write('\n' + formatNotice(pending) + '\n');
}

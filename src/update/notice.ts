// Notice formatting + emission. Kept tiny so callers can wire it into any
// exit path (process.on('exit'), top-level finally, etc.) without surprises.

import type { UpdateInfo } from './check.js';

/**
 * One-line notice formatted for stderr. The update path is the GitHub Release
 * tarball — NOT `npm i -g github:...`: npm has a bug where GLOBAL installs of
 * git dependencies fail on transitive postinstall scripts (`spawn sh ENOENT`
 * on core-js via widdershins; local installs are fine, repro'd on npm 10+11,
 * 2026-06-12). The release asset is built by CI with the exec bit set.
 */
export const UPDATE_COMMAND =
  'npm i -g https://github.com/leeguooooo/openapi-lark/releases/latest/download/openapi-lark.tgz';

export function formatNotice(info: UpdateInfo): string {
  const lines = [
    `[openapi-lark] v${info.latest} available (current ${info.current})`,
    `  update: ${UPDATE_COMMAND}`,
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

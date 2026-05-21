// `openapi-lark install-hook` — idempotently install a git hook that runs
// `openapi-lark sync` after commits / before pushes. Matches the yapi
// docs-sync workflow some teams are migrating from.
//
// Design notes:
//  - Only writes inside .git/hooks/ — touches nothing else
//  - Bracketed block (BEGIN/END markers) so we can re-run safely and uninstall
//    cleanly without trampling user-written hook content
//  - Default hook: post-commit (low friction, async sync after commit lands)
//  - Optional pre-push (heavier; blocks push if sync fails)
//  - --uninstall removes our block, leaves rest of the hook intact

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { EXIT_CONFIG, EXIT_OK } from '../types.js';

export type HookKind = 'post-commit' | 'pre-push';

const BEGIN = '# >>> openapi-lark managed block — do not edit between markers';
const END = '# <<< openapi-lark managed block';

export function buildHookBody(kind: HookKind): string {
  // `--quiet`-like behavior: redirect stdout but keep stderr so failures are
  // visible. post-commit must NEVER exit non-zero (would abort the commit
  // already-recorded). pre-push CAN exit non-zero — that's the whole point
  // of pre-push (block the push if docs aren't ready).
  if (kind === 'post-commit') {
    return [
      BEGIN,
      '# Runs after every commit to keep飞书 wiki in sync.',
      '# post-commit fires AFTER the commit lands; we never `exit !=0` here.',
      '# Skip with: OPENAPI_LARK_SKIP_HOOK=1 git commit ...',
      'if [ -n "$OPENAPI_LARK_SKIP_HOOK" ]; then exit 0; fi',
      'if command -v openapi-lark >/dev/null 2>&1; then',
      '  openapi-lark sync >/dev/null 2>&1 &',
      '  echo "[openapi-lark] sync started in background (PID $!)"',
      'else',
      '  echo "[openapi-lark] command not on PATH, hook skipped" >&2',
      'fi',
      'exit 0',
      END,
    ].join('\n');
  }
  // pre-push
  return [
    BEGIN,
    '# Runs before every push. Blocks the push if sync fails.',
    '# Skip with: OPENAPI_LARK_SKIP_HOOK=1 git push ...',
    'if [ -n "$OPENAPI_LARK_SKIP_HOOK" ]; then exit 0; fi',
    'if command -v openapi-lark >/dev/null 2>&1; then',
    '  if ! openapi-lark sync; then',
    '    echo "[openapi-lark] sync failed — blocking push. Re-run or set OPENAPI_LARK_SKIP_HOOK=1." >&2',
    '    exit 1',
    '  fi',
    'else',
    '  echo "[openapi-lark] command not on PATH, hook skipped (push allowed)" >&2',
    'fi',
    END,
  ].join('\n');
}

/**
 * Compose the new hook file content from existing content + our block. Pure
 * function so it's trivially testable without filesystem.
 *   - empty/missing existing → shebang + our block
 *   - existing with our markers → replace our block (idempotent)
 *   - existing without our markers → preserve verbatim + append our block
 */
export function composeHookContent(
  existing: string | null,
  newBlock: string,
): string {
  const shebang = '#!/bin/sh\n';
  if (!existing || existing.trim() === '') {
    return shebang + '\n' + newBlock + '\n';
  }
  if (existing.includes(BEGIN) && existing.includes(END)) {
    // Replace our managed block, keep everything else.
    const before = existing.slice(0, existing.indexOf(BEGIN));
    const afterMarker = existing.indexOf(END) + END.length;
    const after = existing.slice(afterMarker);
    return before + newBlock + after;
  }
  // Existing hook without our block — append, separated by a blank line.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + newBlock + '\n';
}

/** Same idea but for uninstall: strip our block if present, no-op otherwise. */
export function stripHookBlock(existing: string): string {
  if (!existing.includes(BEGIN) || !existing.includes(END)) return existing;
  const before = existing.slice(0, existing.indexOf(BEGIN));
  const afterMarker = existing.indexOf(END) + END.length;
  const after = existing.slice(afterMarker);
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

export interface InstallHookArgs {
  /** Repo root (where .git lives). Required. */
  cwd: string;
  kind: HookKind;
  uninstall?: boolean;
}

export async function runInstallHook(args: InstallHookArgs): Promise<number> {
  const gitDir = resolve(args.cwd, '.git');
  if (!existsSync(gitDir)) {
    process.stderr.write(`[install-hook] no .git directory at ${args.cwd}\n`);
    return EXIT_CONFIG;
  }
  // .git may be a file (submodule / worktree) pointing elsewhere — handle later
  // if anyone hits it. For now require directory.
  if (!statSync(gitDir).isDirectory()) {
    process.stderr.write(
      `[install-hook] .git is not a directory (likely a worktree or submodule). ` +
        `Install the hook manually in the actual hooks directory.\n`,
    );
    return EXIT_CONFIG;
  }
  const hooksDir = join(gitDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, args.kind);
  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;

  if (args.uninstall) {
    if (existing === null) {
      process.stdout.write(`[install-hook] no ${args.kind} hook present — nothing to do\n`);
      return EXIT_OK;
    }
    const stripped = stripHookBlock(existing);
    if (stripped === existing) {
      process.stdout.write(`[install-hook] no openapi-lark block found in ${args.kind} — nothing to do\n`);
      return EXIT_OK;
    }
    // If stripping leaves just the shebang or nothing meaningful, we could
    // delete the file. But keeping it is safer (user may have other content
    // we didn't recognize).
    writeFileSync(hookPath, stripped, 'utf8');
    process.stdout.write(`[install-hook] removed openapi-lark block from ${hookPath}\n`);
    return EXIT_OK;
  }

  const newBlock = buildHookBody(args.kind);
  const newContent = composeHookContent(existing, newBlock);
  writeFileSync(hookPath, newContent, 'utf8');
  chmodSync(hookPath, 0o755);
  process.stdout.write(
    `[install-hook] wrote ${args.kind} hook at ${hookPath}\n` +
      `       skip per-invocation with: OPENAPI_LARK_SKIP_HOOK=1 git ${args.kind === 'post-commit' ? 'commit' : 'push'} ...\n` +
      `       remove later with: openapi-lark install-hook --uninstall --kind ${args.kind}\n`,
  );
  return EXIT_OK;
}

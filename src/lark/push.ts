import { spawnSync } from 'node:child_process';
import { parsePushOutput } from './parse-output.js';

export type PushFailureReason =
  | 'timeout'
  | 'lark-not-found'
  | 'auth'
  | 'permission'
  | 'non-zero'
  | 'unknown';

export interface PushInput {
  docToken: string;
  /** Path passed to lark-cli's --markdown @<path>. lark-cli requires this to be
   *  relative to `cwd`. Caller is responsible for using a relative path. */
  mdPath: string;
  /** Working directory for the lark-cli subprocess. Defaults to process.cwd(). */
  cwd?: string;
  larkBin?: string;
  timeoutMs: number;
  /** Pass-through for testing — override process.env */
  env?: NodeJS.ProcessEnv;
}

export interface PushSuccess {
  ok: true;
  url: string | null;
  jsonMode: boolean;
  raw: string;
}

export interface PushFailure {
  ok: false;
  reason: PushFailureReason;
  message: string;
  raw: string;
}

export type PushResult = PushSuccess | PushFailure;

/**
 * Real lark-cli v2 surface (verified against lark-cli 1.0.32 + lark-doc skill):
 *   lark-cli docs +update \
 *     --api-version v2 \
 *     --doc <token-or-url> \
 *     --command overwrite \
 *     --doc-format markdown \
 *     --content @<relative-path-to-md>
 *
 * Notes:
 *   - --command overwrite clears the doc and rewrites content (per lark-doc reference:
 *     "⚠️ 清空文档后全文重写（可能丢失图片、评论）" — matches our 文档所有权 contract)
 *   - --content supports @file syntax; path must be RELATIVE to spawn cwd
 *   - --doc-format markdown is required (default is xml)
 *   - lark-cli output is JSON by default; no --json flag exists
 */
const PUSH_BASE_ARGS = [
  'docs',
  '+update',
  '--api-version',
  'v2',
  '--command',
  'overwrite',
  '--doc-format',
  'markdown',
];

function classifyFailure(stderr: string, status: number | null): PushFailureReason {
  const s = stderr.toLowerCase();
  if (s.includes('unauthorized') || s.includes('not logged in') || s.includes('auth')) {
    return 'auth';
  }
  if (s.includes('forbidden') || s.includes('permission') || s.includes('403')) {
    return 'permission';
  }
  if (status !== 0) return 'non-zero';
  return 'unknown';
}

/**
 * Push markdown to a 飞书 docx via lark-cli.
 *
 * Strategy:
 *  1. Try `lark docs +update <token> --api-version v2 --format markdown --file <md> --json`
 *  2. If `--json` is unsupported (stderr mentions "unknown flag"), retry without --json
 *  3. Fall back to regex URL extraction
 *
 * Timeout: spawnSync's `timeout` kills the process via SIGTERM after `timeoutMs`.
 */
export function push(input: PushInput): PushResult {
  const bin = input.larkBin ?? 'lark-cli';
  const args = [
    ...PUSH_BASE_ARGS,
    '--doc',
    input.docToken,
    '--content',
    `@${input.mdPath}`,
  ];
  const spawnOpts = {
    encoding: 'utf8' as const,
    env: input.env ?? process.env,
    cwd: input.cwd,
    timeout: input.timeoutMs,
    maxBuffer: 64 * 1024 * 1024, // 64MB stdout — needed for very large rendered docs
  };

  const res = spawnSync(bin, args, spawnOpts);

  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return {
      ok: false,
      reason: 'lark-not-found',
      message: `lark-cli binary "${bin}" not found in PATH`,
      raw: '',
    };
  }

  // Timeout: spawnSync sets signal to SIGTERM and status null
  if (
    res.signal === 'SIGTERM' ||
    (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  ) {
    return {
      ok: false,
      reason: 'timeout',
      message: `push timed out after ${input.timeoutMs}ms`,
      raw: res.stdout || res.stderr || '',
    };
  }

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';

  if (res.status === 0) {
    const parsed = parsePushOutput(stdout);
    return { ok: true, url: parsed.url, jsonMode: parsed.jsonMode, raw: stdout };
  }

  return {
    ok: false,
    reason: classifyFailure(stderr, res.status),
    message: stderr.split('\n').slice(0, 20).join('\n').trim() || `exit code ${res.status}`,
    raw: stdout + (stderr ? `\n[stderr]\n${stderr}` : ''),
  };
}

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lockfilePath } from './sync-lock.js';
import { nodeMapPath } from './node-map.js';
import { autoTokensPath } from './auto-tokens.js';

/**
 * Detection for the "unshared sync state" footgun.
 *
 * All sync state (hash cache sync-lock.json, identity map node-map.json,
 * auto-created tokens auto-tokens.json) lives in `.openapi-lark/`, which the
 * default setup gitignores. That means a teammate's clone / a new machine
 * starts from zero: the hash cache can't skip anything (full re-push) and the
 * tool has to re-adopt the existing wiki tree from the live titles.
 *
 * `detectUnsharedState` flags exactly that moment — config present but NO
 * local state file exists yet, while git says `.openapi-lark` is ignored —
 * so sync can warn once per machine/clone instead of silently re-pushing.
 */

export type GitRunner = (
  cwd: string,
  args: string[],
) => { status: number | null };

const defaultGitRunner: GitRunner = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: r.status };
};

/** True when `.openapi-lark` is inside a git work tree AND gitignored. */
export function stateIgnoredByGit(
  basedir: string,
  runGit: GitRunner = defaultGitRunner,
): boolean {
  try {
    // Query a file INSIDE the dir, not the bare dir: the stock ignore entry is
    // `.openapi-lark/` (directory-only pattern), which git can't match against
    // a path that doesn't exist on disk yet — exactly the fresh-clone case we
    // care about. A file path matches the pattern regardless of existence.
    // exit 0 = ignored; 1 = not ignored; 128 = not a git repo / other error
    return (
      runGit(basedir, ['check-ignore', '-q', '.openapi-lark/sync-lock.json']).status === 0
    );
  } catch {
    return false;
  }
}

export interface UnsharedStateReport {
  shouldWarn: boolean;
  message: string;
}

export function detectUnsharedState(
  basedir: string,
  runGit: GitRunner = defaultGitRunner,
): UnsharedStateReport {
  const hasLocalState =
    existsSync(lockfilePath(basedir)) ||
    existsSync(nodeMapPath(basedir)) ||
    existsSync(autoTokensPath(basedir));
  if (hasLocalState || !stateIgnoredByGit(basedir, runGit)) {
    return { shouldWarn: false, message: '' };
  }
  return {
    shouldWarn: true,
    message:
      `[sync] ⚠ 本机没有 .openapi-lark/ 同步状态（首次在这台机器 / 这个 clone 上运行），` +
      `且该目录被 .gitignore 忽略，hash 缓存与节点映射不随 git 共享。\n` +
      `        - 若此项目其他人已 sync 过：本次会按标题认领线上已有文档并全量重推（不会重复建树），属预期行为。\n` +
      `        - 多人 / 多机协作建议：把 .openapi-lark/ 移出 .gitignore 并提交（共享增量缓存），` +
      `或固定由一处（如 CI）执行 sync。\n`,
  };
}

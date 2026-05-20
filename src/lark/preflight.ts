import { spawnSync } from 'node:child_process';
import semver from 'semver';
import { EXIT_ENV } from '../types.js';

export class PreflightError extends Error {
  exitCode = EXIT_ENV;
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export interface PreflightInput {
  larkBin?: string;
  larkCliRange: string;
  /** Pass-through for testing — override process.env */
  env?: NodeJS.ProcessEnv;
}

export interface PreflightResult {
  bin: string;
  version: string;
}

/**
 * Probe `lark --version`, ensure it satisfies the configured semver range.
 * Throws PreflightError on missing binary, unparseable version, or mismatch.
 */
export function preflight(input: PreflightInput): PreflightResult {
  const bin = input.larkBin ?? 'lark-cli';
  const res = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    env: input.env ?? process.env,
    timeout: 10_000,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new PreflightError(
      `lark-cli binary "${bin}" not found in PATH. ` +
        `Install lark-cli (e.g. brew install lark-cli) or override with config field "larkBin".`,
    );
  }
  if (res.status !== 0) {
    throw new PreflightError(
      `${bin} --version exited ${res.status}: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  const versionLine = (res.stdout || '').trim().split('\n')[0] ?? '';
  const cleaned = semver.coerce(versionLine);
  if (!cleaned) {
    throw new PreflightError(
      `cannot parse lark-cli version from output: ${JSON.stringify(versionLine)}`,
    );
  }
  if (!semver.satisfies(cleaned, input.larkCliRange, { includePrerelease: true })) {
    throw new PreflightError(
      `lark-cli version ${cleaned.version} does not satisfy engines.larkCli "${input.larkCliRange}". Upgrade lark-cli or relax the constraint.`,
    );
  }
  return { bin, version: cleaned.version };
}

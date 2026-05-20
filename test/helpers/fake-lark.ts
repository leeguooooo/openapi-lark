import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a fake `lark` binary in a temp directory, return the dir to prepend to PATH.
 *
 * The fake reads its scripted behavior from env vars:
 *   FAKE_LARK_STDOUT  — what to print to stdout
 *   FAKE_LARK_STDERR  — what to print to stderr
 *   FAKE_LARK_EXIT    — exit code (default 0)
 *   FAKE_LARK_SLEEP_MS — sleep before exiting (for timeout test)
 */
export function makeFakeLark(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-lark-'));
  const bin = join(dir, 'lark');
  const script = `#!/usr/bin/env node
const sleep = Number.parseInt(process.env.FAKE_LARK_SLEEP_MS || '0', 10);
const stdout = process.env.FAKE_LARK_STDOUT || '';
const stderr = process.env.FAKE_LARK_STDERR || '';
const exit = Number.parseInt(process.env.FAKE_LARK_EXIT || '0', 10);
function emit() {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exit);
}
if (sleep > 0) {
  setTimeout(emit, sleep);
} else {
  emit();
}
`;
  writeFileSync(bin, script, 'utf8');
  chmodSync(bin, 0o755);
  return { dir, bin };
}

export function pathWith(dir: string): string {
  return `${dir}:${process.env.PATH ?? ''}`;
}

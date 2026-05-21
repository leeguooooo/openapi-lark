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

/**
 * Richer fake lark for sync tests that need actual responses (resolveWikiNode,
 * listWikiChildren) while ALSO recording every invocation so tests can assert
 * which write-side calls happened — or didn't, in dry-run.
 *
 * Behavior, by argv prefix:
 *   `--version` / `auth status` → return scripted FAKE_LARK_STDOUT
 *   `wiki spaces get_node`     → return one wiki node (space=SPC1, obj=parentdoc)
 *   `wiki +node-list`          → return empty list (no existing children)
 *   `wiki +node-create`        → return a freshly-minted child node
 *   `docs +update`             → return success with a fake doc url
 *
 * Every invocation appends one JSON line to FAKE_LARK_RECORD_FILE so callers
 * can read it back and assert.
 */
export function makeRecordingLark(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-lark-rec-'));
  const bin = join(dir, 'lark');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const recFile = process.env.FAKE_LARK_RECORD_FILE;
if (recFile) {
  fs.appendFileSync(recFile, JSON.stringify({ args, at: Date.now() }) + '\\n');
}
// Match the deepest specific subcommand first.
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(process.env.FAKE_LARK_STDOUT || '99.99.99\\n');
  process.exit(0);
}
const joined = args.join(' ');
// Optional: make wiki read calls fail to exercise dry-run offline fallback.
// Set FAKE_LARK_WIKI_READ_FAIL=1 to simulate the "user is still waiting for
// wiki:node:read scope approval" scenario.
const wikiReadFail = process.env.FAKE_LARK_WIKI_READ_FAIL === '1';
if (joined.startsWith('wiki spaces get_node')) {
  if (wikiReadFail) {
    process.stdout.write(JSON.stringify({
      code: 99991676, msg: 'permission denied — missing scope wiki:node:read'
    }));
    process.exit(1);
  }
  emit({ code: 0, msg: 'ok', data: { node: {
    space_id: 'SPC1', node_token: 'NODE_PARENT', obj_token: 'parentdoc',
    obj_type: 'docx', title: 'Parent', parent_node_token: '',
  } } });
}
if (joined.startsWith('wiki +node-list')) {
  if (wikiReadFail) {
    process.stdout.write(JSON.stringify({
      code: 99991676, msg: 'permission denied — missing scope wiki:node:read'
    }));
    process.exit(1);
  }
  emit({ code: 0, msg: 'ok', data: { items: [], has_more: false } });
}
if (joined.startsWith('wiki +node-create')) {
  // Counter — each call gets a fresh token so we can tell apart
  const idx = parseInt(process.env.FAKE_LARK_CREATE_COUNTER || '0', 10) + 1;
  process.env.FAKE_LARK_CREATE_COUNTER = String(idx);
  emit({ code: 0, msg: 'ok', data: { node: {
    space_id: 'SPC1', node_token: 'NODE_C' + idx, obj_token: 'doc_c' + idx,
    obj_type: 'docx', title: 'Child', has_child: false,
  } } });
}
if (joined.startsWith('docs +update') || joined.startsWith('docs update')) {
  emit({ code: 0, data: { url: 'https://example.feishu.cn/docx/fake' } });
}
// Default: succeed quietly so unknown calls don't break preflight etc.
process.stdout.write('99.99.99\\n');
process.exit(0);
`;
  writeFileSync(bin, script, 'utf8');
  chmodSync(bin, 0o755);
  return { dir, bin };
}

export function readRecord(recFile: string): Array<{ args: string[]; at: number }> {
  try {
    const raw = require('node:fs').readFileSync(recFile, 'utf8') as string;
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

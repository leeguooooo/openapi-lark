// Regression test for: endpoint/tree mode --dry-run accidentally pushing to
// production wiki (reported by zego-im-chat user). Dry-run MUST NOT call
// createWikiChild or docs +update, regardless of service mode.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync } from '../src/commands/sync.js';
import { EXIT_OK } from '../src/types.js';
import { makeRecordingLark, pathWith, readRecord } from './helpers/fake-lark.js';

const FIXTURES = resolve(__dirname, 'fixtures/openapi');

let fakeDir: string;
let recordFile: string;
let origPath: string | undefined;
let origRecord: string | undefined;
let workdir: string;

beforeAll(() => {
  fakeDir = makeRecordingLark().dir;
  origPath = process.env.PATH;
  process.env.PATH = pathWith(fakeDir);
});

afterAll(() => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  rmSync(fakeDir, { recursive: true, force: true });
});

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'openapi-lark-drm-'));
  mkdirSync(join(workdir, 'api'), { recursive: true });
  cpSync(join(FIXTURES, 'minimal.yaml'), join(workdir, 'api/openapi.yaml'));
  recordFile = join(workdir, 'lark-calls.jsonl');
  origRecord = process.env.FAKE_LARK_RECORD_FILE;
  process.env.FAKE_LARK_RECORD_FILE = recordFile;
});

afterEach(() => {
  if (origRecord === undefined) delete process.env.FAKE_LARK_RECORD_FILE;
  else process.env.FAKE_LARK_RECORD_FILE = origRecord;
  rmSync(workdir, { recursive: true, force: true });
});

function writeConfig(mode: 'endpoint' | 'tree'): string {
  const cfg = join(workdir, '.openapi-lark.yaml');
  writeFileSync(
    cfg,
    [
      'engines:',
      '  larkCli: ">=0.0.0"',
      // Point at the fake binary (named `lark`, not `lark-cli`)
      'larkBin: lark',
      'services:',
      '  - name: svc',
      '    openapi: api/openapi.yaml',
      `    mode: ${mode}`,
      '    docToken: parentdoc',
      '',
    ].join('\n'),
    'utf8',
  );
  return cfg;
}

function assertNoWrites(records: ReturnType<typeof readRecord>): void {
  const writeCalls = records.filter((r) => {
    const j = r.args.join(' ');
    return j.startsWith('wiki +node-create') || j.startsWith('docs +update');
  });
  if (writeCalls.length > 0) {
    const summary = writeCalls.map((c) => '  ' + c.args.join(' ')).join('\n');
    throw new Error(
      `dry-run made ${writeCalls.length} write-side lark call(s) — these would have hit production:\n${summary}`,
    );
  }
}

describe('sync --dry-run / endpoint mode', () => {
  it('does not call wiki +node-create or docs +update', async () => {
    const cfg = writeConfig('endpoint');
    const code = await runSync({
      configPath: cfg,
      dryRun: true,
    });
    expect(code).toBe(EXIT_OK);
    const records = readRecord(recordFile);
    assertNoWrites(records);
    // Sanity: read-side calls (resolveWikiNode, listWikiChildren) should have run
    const reads = records.filter((r) =>
      r.args.join(' ').startsWith('wiki spaces get_node'),
    );
    expect(reads.length).toBeGreaterThan(0);
  }, 30_000);

  it('still renders markdown to disk under .openapi-lark/<svc>/', async () => {
    const cfg = writeConfig('endpoint');
    await runSync({ configPath: cfg, dryRun: true });
    const outDir = join(workdir, '.openapi-lark', 'svc');
    const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => f.name);
    expect(files.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('sync --dry-run / tree mode', () => {
  it('does not call wiki +node-create or docs +update', async () => {
    const cfg = writeConfig('tree');
    const code = await runSync({
      configPath: cfg,
      dryRun: true,
    });
    expect(code).toBe(EXIT_OK);
    const records = readRecord(recordFile);
    assertNoWrites(records);
  }, 30_000);

  it('still renders per-tag markdown to disk', async () => {
    const cfg = writeConfig('tree');
    await runSync({ configPath: cfg, dryRun: true });
    const outDir = join(workdir, '.openapi-lark', 'svc');
    const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => f.name);
    expect(files.length).toBeGreaterThan(0);
  }, 30_000);
});

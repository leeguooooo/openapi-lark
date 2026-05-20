import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync } from '../src/commands/sync.js';
import { EXIT_OK } from '../src/types.js';
import { makeFakeLark, pathWith } from './helpers/fake-lark.js';

const FIXTURES = resolve(__dirname, 'fixtures/openapi');

let workdir: string;
let fakeLarkDir: string;
let origPath: string | undefined;
let origLarkStdout: string | undefined;
let origLarkExit: string | undefined;

beforeAll(() => {
  fakeLarkDir = makeFakeLark().dir;
  origPath = process.env.PATH;
  origLarkStdout = process.env.FAKE_LARK_STDOUT;
  origLarkExit = process.env.FAKE_LARK_EXIT;
  process.env.PATH = pathWith(fakeLarkDir);
  process.env.FAKE_LARK_STDOUT = '99.99.99\n';
  process.env.FAKE_LARK_EXIT = '0';
});

afterAll(() => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  if (origLarkStdout === undefined) delete process.env.FAKE_LARK_STDOUT;
  else process.env.FAKE_LARK_STDOUT = origLarkStdout;
  if (origLarkExit === undefined) delete process.env.FAKE_LARK_EXIT;
  else process.env.FAKE_LARK_EXIT = origLarkExit;
  rmSync(fakeLarkDir, { recursive: true, force: true });
});

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'openapi-lark-sync-'));
  mkdirSync(join(workdir, 'api'), { recursive: true });
  cpSync(join(FIXTURES, 'minimal.yaml'), join(workdir, 'api/openapi.yaml'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('sync --dry-run', () => {
  it('renders all services to ./.openapi-lark/<svc>.md, no push, exit 0', async () => {
    const cfg = join(workdir, '.openapi-lark.yaml');
    writeFileSync(
      cfg,
      `engines:
  larkCli: ">=0.0.0"
services:
  - name: voice-room
    openapi: api/openapi.yaml
    docToken: doccnDRYRUNAAAA
`,
      'utf8',
    );
    const exitCode = await runSync({ configPath: cfg, dryRun: true });
    expect(exitCode).toBe(EXIT_OK);
    const out = join(workdir, '.openapi-lark', 'voice-room.md');
    expect(existsSync(out)).toBe(true);
    const md = readFileSync(out, 'utf8');
    expect(md.length).toBeGreaterThan(50);
    expect(md).toMatch(/Minimal Test API|Ping/);
  }, 60_000);

  it('rejects --parallel 0', async () => {
    const cfg = join(workdir, '.openapi-lark.yaml');
    writeFileSync(
      cfg,
      `engines:
  larkCli: ">=0.0.0"
services:
  - name: a
    openapi: api/openapi.yaml
    docToken: doccnAAAAAAAA
`,
      'utf8',
    );
    const exitCode = await runSync({ configPath: cfg, dryRun: true, parallel: 0 });
    expect(exitCode).toBe(2);
  }, 60_000);

  it('clamps --parallel to services.length', async () => {
    const cfg = join(workdir, '.openapi-lark.yaml');
    writeFileSync(
      cfg,
      `engines:
  larkCli: ">=0.0.0"
services:
  - name: a
    openapi: api/openapi.yaml
    docToken: doccnAAAAAAAA
`,
      'utf8',
    );
    // parallel=99 with only 1 service should not crash and should succeed
    const exitCode = await runSync({
      configPath: cfg,
      dryRun: true,
      parallel: 99,
    });
    expect(exitCode).toBe(EXIT_OK);
  }, 60_000);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { extractDocToken, readOpenapiTitle, runInit, diagnoseOpenapiSource } from '../src/commands/init.js';

describe('extractDocToken', () => {
  it('extracts from feishu.cn /docx/', () => {
    expect(extractDocToken('https://feishu.cn/docx/doccnABC123')).toBe('doccnABC123');
  });
  it('extracts from feishu.cn /wiki/', () => {
    expect(extractDocToken('https://feishu.cn/wiki/wikXYZ1234')).toBe('wikXYZ1234');
  });
  it('extracts from larksuite.com /docx/', () => {
    expect(extractDocToken('https://a.larksuite.com/docx/abcDEF1234')).toBe('abcDEF1234');
  });
  it('extracts from larkoffice.com /docs/', () => {
    expect(extractDocToken('https://x.larkoffice.com/docs/doc123token')).toBe(
      'doc123token',
    );
  });
  it('strips query and fragment', () => {
    expect(
      extractDocToken('https://feishu.cn/docx/abc12345?from=mobile#section'),
    ).toBe('abc12345');
  });
  it('returns null for non-feishu host', () => {
    expect(extractDocToken('https://example.com/docx/abc')).toBeNull();
  });
  it('returns null for malformed url', () => {
    expect(extractDocToken('not-a-url')).toBeNull();
  });
  it('returns null when token shape invalid (too short)', () => {
    expect(extractDocToken('https://feishu.cn/docx/abc')).toBeNull();
  });

  it('extracts from known marker (minutes) when shape valid', () => {
    expect(extractDocToken('https://feishu.cn/minutes/mtABCDEFGH123')).toBe(
      'mtABCDEFGH123',
    );
  });

  it('returns null for admin/share paths (no marker matched)', () => {
    // codex round-6 Q3: paths like /spaces/manage/<UUID> must NOT be silently accepted
    expect(extractDocToken('https://feishu.cn/spaces/manage/AbcDef12345678')).toBeNull();
  });

  it('returns null for single-segment path', () => {
    expect(extractDocToken('https://feishu.cn/home')).toBeNull();
  });
});

describe('readOpenapiTitle', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'openapi-lark-init-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('reads info.title from yaml', () => {
    const p = join(workdir, 'api.yaml');
    writeFileSync(p, 'openapi: 3.0.0\ninfo:\n  title: My Service\n  version: 1.0\npaths: {}\n');
    expect(readOpenapiTitle(p)).toBe('My Service');
  });

  it('reads info.title from json', () => {
    const p = join(workdir, 'api.json');
    writeFileSync(p, JSON.stringify({ info: { title: 'JSON Svc' } }));
    expect(readOpenapiTitle(p)).toBe('JSON Svc');
  });

  it('returns null when file missing', () => {
    expect(readOpenapiTitle(join(workdir, 'nope.yaml'))).toBeNull();
  });

  it('returns null when info.title absent', () => {
    const p = join(workdir, 'no-title.yaml');
    writeFileSync(p, 'openapi: 3.0.0\npaths: {}\n');
    expect(readOpenapiTitle(p)).toBeNull();
  });

  it('returns null for unparseable', () => {
    const p = join(workdir, 'bad.yaml');
    writeFileSync(p, '{ not: valid: yaml ::: ');
    expect(readOpenapiTitle(p)).toBeNull();
  });
});

describe('runInit defaults', () => {
  let workdir: string;
  let cwdOrig: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'openapi-lark-init-run-'));
    cwdOrig = process.cwd();
    process.chdir(workdir);
  });
  afterEach(() => {
    process.chdir(cwdOrig);
    rmSync(workdir, { recursive: true, force: true });
  });

  it('writes mode: endpoint and parentTitle from info.title', async () => {
    writeFileSync(
      'api.yaml',
      'openapi: 3.0.0\ninfo:\n  title: Voice Room\n  version: 1.0\npaths: {}\n',
    );
    const code = await runInit({
      name: 'voice',
      openapi: 'api.yaml',
      docUrl: 'https://feishu.cn/wiki/wikXYZ12345',
      configPath: '.openapi-lark.yaml',
    });
    expect(code).toBe(0);
    const cfg = parseYaml(readFileSync('.openapi-lark.yaml', 'utf8')) as any;
    expect(cfg.services[0]).toMatchObject({
      name: 'voice',
      openapi: 'api.yaml',
      mode: 'endpoint',
      parentTitle: 'Voice Room',
      docToken: 'wikXYZ12345',
    });
  });

  it('omits parentTitle when openapi file is missing (URL or pre-init)', async () => {
    const code = await runInit({
      name: 'remote-svc',
      openapi: 'https://example.com/openapi.json',
      docUrl: 'https://feishu.cn/wiki/wikXYZ12345',
      configPath: '.openapi-lark.yaml',
    });
    expect(code).toBe(0);
    const cfg = parseYaml(readFileSync('.openapi-lark.yaml', 'utf8')) as any;
    expect(cfg.services[0].mode).toBe('endpoint');
    expect(cfg.services[0].parentTitle).toBeUndefined();
  });

  it('preserves user-edited keys on re-init', async () => {
    writeFileSync(
      '.openapi-lark.yaml',
      'engines:\n  larkCli: ">=0.1.0"\nservices:\n  - name: voice\n    openapi: api.yaml\n    docToken: wikXYZ12345\n    render:\n      engine: widdershins\n',
    );
    writeFileSync(
      'api.yaml',
      'openapi: 3.0.0\ninfo:\n  title: Voice Room\n  version: 1.0\npaths: {}\n',
    );
    const code = await runInit({
      name: 'voice',
      openapi: 'api.yaml',
      docUrl: 'https://feishu.cn/wiki/wikXYZ12345',
      configPath: '.openapi-lark.yaml',
    });
    expect(code).toBe(0);
    const cfg = parseYaml(readFileSync('.openapi-lark.yaml', 'utf8')) as any;
    expect(cfg.services[0]).toMatchObject({
      name: 'voice',
      mode: 'endpoint',
      parentTitle: 'Voice Room',
      render: { engine: 'widdershins' },
    });
  });
});

describe('diagnoseOpenapiSource', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'openapi-lark-diag-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('detects Hono', () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ dependencies: { hono: '^4.0.0' } }),
    );
    const hints = diagnoseOpenapiSource(workdir);
    expect(hints.some((h) => h.includes('Hono'))).toBe(true);
  });

  it('detects chanfana', () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ dependencies: { chanfana: '^1.0.0' } }),
    );
    const hints = diagnoseOpenapiSource(workdir);
    expect(hints.some((h) => h.includes('chanfana'))).toBe(true);
  });

  it('detects NestJS', () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ dependencies: { '@nestjs/core': '^10.0.0' } }),
    );
    const hints = diagnoseOpenapiSource(workdir);
    expect(hints.some((h) => h.includes('NestJS'))).toBe(true);
  });

  it('detects Python via requirements.txt', () => {
    writeFileSync(join(workdir, 'requirements.txt'), 'fastapi==0.100.0\n');
    const hints = diagnoseOpenapiSource(workdir);
    expect(hints.some((h) => h.includes('FastAPI'))).toBe(true);
  });

  it('emits docs/ hint when present (also with no framework)', () => {
    require('node:fs').mkdirSync(join(workdir, 'docs'));
    const hints = diagnoseOpenapiSource(workdir);
    expect(hints.some((h) => h.includes('docs/'))).toBe(true);
  });

  it('emits BOTH framework and docs/ hints when both present (real Hono case)', () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ dependencies: { hono: '^4.0.0' } }),
    );
    require('node:fs').mkdirSync(join(workdir, 'docs'));
    const hints = diagnoseOpenapiSource(workdir);
    expect(hints.some((h) => h.includes('Hono'))).toBe(true);
    expect(hints.some((h) => h.includes('docs/'))).toBe(true);
  });

  it('returns empty array for unrecognized project', () => {
    expect(diagnoseOpenapiSource(workdir)).toEqual([]);
  });

  it('survives unreadable package.json', () => {
    writeFileSync(join(workdir, 'package.json'), '{ not valid json');
    expect(() => diagnoseOpenapiSource(workdir)).not.toThrow();
  });
});

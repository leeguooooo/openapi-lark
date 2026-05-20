import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config/load.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'openapi-lark-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): string {
  const full = join(tmpRoot, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

describe('config/load', () => {
  it('loads a minimal valid config', () => {
    const path = writeFile(
      '.openapi-lark.yaml',
      `engines:
  larkCli: ">=0.1.0"
services:
  - name: a
    openapi: api/a.yaml
    docToken: doccnABCDEFGH
`,
    );
    const loaded = loadConfig({ configPath: path, env: {} });
    expect(loaded.config.services[0].name).toBe('a');
    expect(loaded.config.services[0].docToken).toBe('doccnABCDEFGH');
    expect(loaded.config.engines.larkCli).toBe('>=0.1.0');
    expect(loaded.config.pushTimeoutMs).toBe(120_000);
    expect(loaded.config.maxResolvedSizeBytes).toBe(50 * 1024 * 1024);
  });

  it('case 1: child overrides parent env reference for same-name service', () => {
    writeFile(
      'shared/base.yaml',
      `engines:
  larkCli: ">=0.1.0"
services:
  - name: a
    openapi: api/a.yaml
    docToken: \${LARK_PARENT}
`,
    );
    const childPath = writeFile(
      '.openapi-lark.yaml',
      `extends: ./shared/base.yaml
services:
  - name: a
    openapi: api/a.yaml
    docToken: \${LARK_CHILD}
`,
    );
    const loaded = loadConfig({
      configPath: childPath,
      env: { LARK_CHILD: 'doccnCHILDXXXX' },
    });
    expect(loaded.config.services[0].docToken).toBe('doccnCHILDXXXX');
  });

  it('case 2: parent env undefined but child overrides → no hard fail (extends先于插值)', () => {
    writeFile(
      'shared/base.yaml',
      `engines:
  larkCli: ">=0.1.0"
services:
  - name: a
    openapi: api/a.yaml
    docToken: \${UNDEFINED_PARENT}
`,
    );
    const childPath = writeFile(
      '.openapi-lark.yaml',
      `extends: ./shared/base.yaml
services:
  - name: a
    openapi: api/a.yaml
    docToken: doccnLITERALXX
`,
    );
    const loaded = loadConfig({ configPath: childPath, env: {} });
    expect(loaded.config.services[0].docToken).toBe('doccnLITERALXX');
  });

  it('case 3: parent env undefined and child does NOT override → hard fail', () => {
    writeFile(
      'shared/base.yaml',
      `engines:
  larkCli: ">=0.1.0"
services:
  - name: a
    openapi: api/a.yaml
    docToken: \${UNDEFINED_PARENT}
`,
    );
    const childPath = writeFile(
      '.openapi-lark.yaml',
      `extends: ./shared/base.yaml
`,
    );
    expect(() => loadConfig({ configPath: childPath, env: {} })).toThrow(
      /UNDEFINED_PARENT/,
    );
  });

  it('case 4: non-service field (engines.larkCli) env override also works', () => {
    writeFile(
      'shared/base.yaml',
      `engines:
  larkCli: \${PARENT_ENGINE}
services:
  - name: a
    openapi: api/a.yaml
    docToken: doccnAAAAAAAA
`,
    );
    const childPath = writeFile(
      '.openapi-lark.yaml',
      `extends: ./shared/base.yaml
engines:
  larkCli: ">=1.2.3"
`,
    );
    const loaded = loadConfig({ configPath: childPath, env: {} });
    expect(loaded.config.engines.larkCli).toBe('>=1.2.3');
  });

  it('case 5: extends chain > 1 level → hard fail', () => {
    writeFile(
      'shared/grandparent.yaml',
      `engines:
  larkCli: ">=0.1.0"
services:
  - name: a
    openapi: api/a.yaml
    docToken: doccnAAAAAAAA
`,
    );
    writeFile(
      'shared/parent.yaml',
      `extends: ./grandparent.yaml
services:
  - name: a
    openapi: api/a.yaml
    docToken: doccnBBBBBBBB
`,
    );
    const childPath = writeFile(
      '.openapi-lark.yaml',
      `extends: ./shared/parent.yaml
`,
    );
    expect(() => loadConfig({ configPath: childPath, env: {} })).toThrow(
      /extends chain exceeds 1 level/,
    );
  });

  it('case 6: services dedupe by name — child wins, no duplicates', () => {
    writeFile(
      'shared/base.yaml',
      `engines:
  larkCli: ">=0.1.0"
services:
  - name: a
    openapi: api/a-old.yaml
    docToken: doccnPARENTAAA
  - name: b
    openapi: api/b.yaml
    docToken: doccnPARENTBBB
`,
    );
    const childPath = writeFile(
      '.openapi-lark.yaml',
      `extends: ./shared/base.yaml
services:
  - name: a
    openapi: api/a-new.yaml
    docToken: doccnCHILDAAAA
`,
    );
    const loaded = loadConfig({ configPath: childPath, env: {} });
    expect(loaded.config.services).toHaveLength(2);
    const a = loaded.config.services.find((s) => s.name === 'a');
    const b = loaded.config.services.find((s) => s.name === 'b');
    expect(a?.openapi).toBe('api/a-new.yaml');
    expect(a?.docToken).toBe('doccnCHILDAAAA');
    expect(b?.docToken).toBe('doccnPARENTBBB');
  });

  it('engines.larkCli is required → exit 2 message mentions it', () => {
    const path = writeFile(
      '.openapi-lark.yaml',
      `services:
  - name: a
    openapi: api/a.yaml
    docToken: doccnAAAAAAAA
`,
    );
    let caught: unknown;
    try {
      loadConfig({ configPath: path, env: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toMatch(/engines/i);
  });

  it('rejects extends target not found', () => {
    const path = writeFile(
      '.openapi-lark.yaml',
      `extends: ./missing.yaml
engines:
  larkCli: ">=0.1.0"
services:
  - name: a
    openapi: api/a.yaml
    docToken: doccnAAAAAAAA
`,
    );
    expect(() => loadConfig({ configPath: path, env: {} })).toThrow(
      /extends target not found/,
    );
  });

  it('rejects duplicate service names', () => {
    const path = writeFile(
      '.openapi-lark.yaml',
      `engines:
  larkCli: ">=0.1.0"
services:
  - name: a
    openapi: api/a.yaml
    docToken: doccnAAAAAAAA
  - name: a
    openapi: api/b.yaml
    docToken: doccnBBBBBBBB
`,
    );
    expect(() => loadConfig({ configPath: path, env: {} })).toThrow(
      /duplicate service name/,
    );
  });
});

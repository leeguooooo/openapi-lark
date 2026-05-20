import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { render, RenderError } from '../src/renderer/index.js';
import { DEFAULT_MAX_RESOLVED_SIZE_BYTES } from '../src/types.js';

const FIXTURES = resolve(__dirname, 'fixtures/openapi');

describe('renderer (widdershins)', () => {
  it('renders minimal openapi to markdown', async () => {
    const out = await render({
      openapiPath: resolve(FIXTURES, 'minimal.yaml'),
      engine: 'widdershins',
      maxResolvedSizeBytes: DEFAULT_MAX_RESOLVED_SIZE_BYTES,
    });
    expect(out.markdown.length).toBeGreaterThan(0);
    expect(out.markdown).toMatch(/Minimal Test API|Ping|Echo/);
    expect(out.resolvedSizeBytes).toBeGreaterThan(0);
  }, 30_000);

  it('renders nested-schema fixture', async () => {
    const out = await render({
      openapiPath: resolve(FIXTURES, 'nested-schema.yaml'),
      engine: 'widdershins',
      maxResolvedSizeBytes: DEFAULT_MAX_RESOLVED_SIZE_BYTES,
    });
    expect(out.markdown).toMatch(/User|Profile|Address/);
  }, 30_000);

  it('rejects --engine native with helpful message', async () => {
    await expect(
      render({
        openapiPath: resolve(FIXTURES, 'minimal.yaml'),
        engine: 'native' as 'widdershins',
        maxResolvedSizeBytes: DEFAULT_MAX_RESOLVED_SIZE_BYTES,
      }),
    ).rejects.toBeInstanceOf(RenderError);
  });

  it('rejects when resolved size exceeds maxResolvedSizeBytes', async () => {
    await expect(
      render({
        openapiPath: resolve(FIXTURES, 'minimal.yaml'),
        engine: 'widdershins',
        maxResolvedSizeBytes: 100, // tiny — should always fail
      }),
    ).rejects.toThrow(/exceeds maxResolvedSizeBytes/);
  }, 30_000);
});

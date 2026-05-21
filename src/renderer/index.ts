import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { Engine } from '../types.js';
import { renderWiddershins } from './widdershins/render.js';
import type { HeadingWarning } from './heading-check.js';
import { EXIT_CONFIG } from '../types.js';
import { flattenAllOfInApi } from './flatten-allof.js';
import { isOpenapiUrl } from '../config/load.js';

export class RenderError extends Error {
  exitCode = EXIT_CONFIG;
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export interface RenderRequest {
  openapiPath: string;
  engine: Engine;
  maxResolvedSizeBytes: number;
  /** Forwarded to loadAndDereference when openapiPath is a URL */
  urlOpts?: OpenapiSourceOptions;
}

export interface RenderResponse {
  markdown: string;
  headingWarnings: HeadingWarning[];
  resolvedSizeBytes: number;
}

/**
 * Render an in-memory OpenAPI object (already dereferenced). Used by tree mode
 * which slices the api by tag before rendering each subset.
 *
 * `singleOperationSummary` enables a "collapse redundant operation intro"
 * post-process that's only safe for endpoint-mode leaf docs (one op per api).
 */
export async function renderApi(
  api: unknown,
  engine: Engine = 'widdershins',
  singleOperationSummary?: string,
): Promise<{ markdown: string; headingWarnings: HeadingWarning[] }> {
  if (engine === 'native') {
    throw new RenderError(
      `--engine native is not implemented in v1; see Phase v1.5 in the spec. Use widdershins.`,
    );
  }
  const { renderWiddershins } = await import('./widdershins/render.js');
  return renderWiddershins({ api, singleOperationSummary });
}

export interface OpenapiSourceOptions {
  /** Headers for URL fetch — usually for `Authorization: Bearer ${TOKEN}` */
  headers?: Record<string, string>;
  /** When the source is a URL, write the raw fetched JSON to this absolute path */
  snapshotAbsPath?: string;
  /** Fetch timeout in ms; default 30s */
  fetchTimeoutMs?: number;
}

/**
 * Fetch a remote OpenAPI document. Returns the raw text + Content-Type so the
 * caller can decide JSON vs YAML parsing. No retries — we surface failures
 * fast and let the user decide.
 */
async function fetchOpenapi(
  url: string,
  opts: OpenapiSourceOptions,
): Promise<{ text: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.fetchTimeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      headers: opts.headers ?? {},
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new RenderError(
        `fetch ${url} failed: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const text = await res.text();
    return { text, contentType: res.headers.get('content-type') ?? '' };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new RenderError(`fetch ${url} timed out after ${opts.fetchTimeoutMs ?? 30_000}ms`);
    }
    if (err instanceof RenderError) throw err;
    throw new RenderError(`fetch ${url} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load + dereference openapi from path OR URL, then size-guard.
 * Used by single mode and `render` command.
 *
 * For URLs:
 *  - Always fetches with our own client (so headers + snapshot work)
 *  - SwaggerParser receives the parsed object; **external $refs to OTHER URLs
 *    are not resolved** (limitation: the bundled openapi.json from chanfana/
 *    Hono/FastAPI is normally self-contained, so this rarely matters)
 *
 * For local paths: existing behavior (delegates to SwaggerParser).
 */
export async function loadAndDereference(
  openapiPath: string,
  maxResolvedSizeBytes: number,
  urlOpts?: OpenapiSourceOptions,
): Promise<{ api: unknown; resolvedSizeBytes: number }> {
  let api: any;
  try {
    if (isOpenapiUrl(openapiPath)) {
      const { text } = await fetchOpenapi(openapiPath, urlOpts ?? {});
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // YAML fallback — chanfana/Hono almost always JSON; FastAPI optional yaml endpoint
        const yaml = await import('yaml');
        parsed = yaml.parse(text);
      }
      // Snapshot — write BEFORE dereference so a broken spec still leaves a diffable file
      if (urlOpts?.snapshotAbsPath) {
        const pretty = JSON.stringify(parsed, null, 2);
        mkdirSync(dirname(urlOpts.snapshotAbsPath), { recursive: true });
        writeFileSync(urlOpts.snapshotAbsPath, pretty, 'utf8');
      }
      api = await SwaggerParser.dereference(parsed as any);
    } else {
      api = await SwaggerParser.dereference(openapiPath);
    }
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(
      `failed to load/dereference openapi at ${openapiPath}: ${(err as Error).message}`,
    );
  }
  // Flatten allOf compositions so widdershins can render the schema tables
  // for responses using `BaseResponse + payload` patterns. Without this, every
  // such response shows "Inline" with no field details.
  api = flattenAllOfInApi(api);
  let resolvedSizeBytes: number;
  try {
    resolvedSizeBytes = Buffer.byteLength(JSON.stringify(api), 'utf8');
  } catch (err) {
    throw new RenderError(
      `openapi contains structures incompatible with JSON.stringify (likely circular reference): ${(err as Error).message}`,
    );
  }
  if (resolvedSizeBytes > maxResolvedSizeBytes) {
    throw new RenderError(
      `resolved openapi size ${(resolvedSizeBytes / 1024 / 1024).toFixed(2)} MB exceeds maxResolvedSizeBytes ` +
        `(${(maxResolvedSizeBytes / 1024 / 1024).toFixed(2)} MB). ` +
        `Either split the openapi or raise maxResolvedSizeBytes in your config.`,
    );
  }
  return { api, resolvedSizeBytes };
}

export async function render(req: RenderRequest): Promise<RenderResponse> {
  if (req.engine === 'native') {
    throw new RenderError(
      `--engine native is not implemented in v1; see Phase v1.5 in the spec. Use widdershins.`,
    );
  }
  if (req.engine !== 'widdershins') {
    throw new RenderError(`unknown engine: ${req.engine}`);
  }
  const { api, resolvedSizeBytes } = await loadAndDereference(
    req.openapiPath,
    req.maxResolvedSizeBytes,
    req.urlOpts,
  );
  const out = await renderWiddershins({ api });
  return {
    markdown: out.markdown,
    headingWarnings: out.headingWarnings,
    resolvedSizeBytes,
  };
}

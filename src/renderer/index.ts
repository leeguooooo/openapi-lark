import SwaggerParser from '@apidevtools/swagger-parser';
import type { Engine } from '../types.js';
import { renderWiddershins } from './widdershins/render.js';
import type { HeadingWarning } from './heading-check.js';
import { EXIT_CONFIG } from '../types.js';
import { flattenAllOfInApi } from './flatten-allof.js';

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

/**
 * Load + dereference openapi from path, then render with size guard.
 * Used by single mode and `render` command.
 */
export async function loadAndDereference(
  openapiPath: string,
  maxResolvedSizeBytes: number,
): Promise<{ api: unknown; resolvedSizeBytes: number }> {
  let api: any;
  try {
    api = await SwaggerParser.dereference(openapiPath);
  } catch (err) {
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
  );
  const out = await renderWiddershins({ api });
  return {
    markdown: out.markdown,
    headingWarnings: out.headingWarnings,
    resolvedSizeBytes,
  };
}

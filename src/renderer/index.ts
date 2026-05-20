import SwaggerParser from '@apidevtools/swagger-parser';
import type { Engine } from '../types.js';
import { renderWiddershins } from './widdershins/render.js';
import type { HeadingWarning } from './heading-check.js';
import { EXIT_CONFIG } from '../types.js';

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

export async function render(req: RenderRequest): Promise<RenderResponse> {
  if (req.engine === 'native') {
    throw new RenderError(
      `--engine native is not implemented in v1; see Phase v1.5 in the spec. Use widdershins.`,
    );
  }
  if (req.engine !== 'widdershins') {
    throw new RenderError(`unknown engine: ${req.engine}`);
  }

  let api: unknown;
  try {
    api = await SwaggerParser.dereference(req.openapiPath);
  } catch (err) {
    throw new RenderError(
      `failed to load/dereference openapi at ${req.openapiPath}: ${(err as Error).message}`,
    );
  }

  // Measurement per spec: JSON.stringify byte length of the dereferenced object.
  // Note: schemas with circular refs would fail here; swagger-parser handles this
  // by leaving $refs in place where cycles exist. If JSON.stringify still throws,
  // re-throw as a user-friendly error.
  let resolvedSizeBytes: number;
  try {
    resolvedSizeBytes = Buffer.byteLength(JSON.stringify(api), 'utf8');
  } catch (err) {
    throw new RenderError(
      `openapi contains structures incompatible with JSON.stringify (likely circular reference): ${(err as Error).message}`,
    );
  }
  if (resolvedSizeBytes > req.maxResolvedSizeBytes) {
    throw new RenderError(
      `resolved openapi size ${(resolvedSizeBytes / 1024 / 1024).toFixed(2)} MB exceeds maxResolvedSizeBytes ` +
        `(${(req.maxResolvedSizeBytes / 1024 / 1024).toFixed(2)} MB). ` +
        `Either split the openapi or raise maxResolvedSizeBytes in your config.`,
    );
  }

  const out = await renderWiddershins({ api });
  return {
    markdown: out.markdown,
    headingWarnings: out.headingWarnings,
    resolvedSizeBytes,
  };
}

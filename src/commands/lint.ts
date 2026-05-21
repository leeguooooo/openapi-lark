import { existsSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import { loadConfig, resolveOpenapiPath, isOpenapiUrl, ConfigError } from '../config/load.js';
import { loadAndDereference } from '../renderer/index.js';
import { EXIT_BUSINESS, EXIT_CONFIG, EXIT_OK } from '../types.js';

export interface LintArgs {
  service?: string;
  configPath: string;
  /** Fail on OpenAPI spec strict-validation issues (e.g. extra `$schema` field
   *  injected by TS→OpenAPI generators). Default: warn-only, don't fail. */
  strict?: boolean;
}

export async function runLint(args: LintArgs): Promise<number> {
  let loaded;
  try {
    loaded = loadConfig({ configPath: args.configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[lint] config error: ${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }
  const services = args.service
    ? loaded.config.services.filter((s) => s.name === args.service)
    : loaded.config.services;
  if (services.length === 0) {
    process.stderr.write(`[lint] no service matched: ${args.service ?? '<all>'}\n`);
    return EXIT_CONFIG;
  }
  let failed = 0;
  for (const svc of services) {
    const openapiPath = resolveOpenapiPath(loaded.basedir, svc.openapi);
    const isUrl = isOpenapiUrl(openapiPath);
    if (!isUrl && !existsSync(openapiPath)) {
      process.stderr.write(
        `[lint] ${svc.name}: openapi file not found at ${openapiPath}\n`,
      );
      failed++;
      continue;
    }
    // Step 1: dereference (load + resolve refs) — must pass; this is what
    // render.ts uses. If this fails, render WILL fail. For URL sources we
    // route through loadAndDereference so openapiHeaders work for validate
    // step too (SwaggerParser native URL fetch has no header support).
    let derefApi: unknown | undefined;
    try {
      if (isUrl) {
        const r = await loadAndDereference(
          openapiPath,
          loaded.config.maxResolvedSizeBytes,
          { headers: svc.openapiHeaders },
        );
        derefApi = r.api;
      } else {
        await SwaggerParser.dereference(openapiPath);
      }
    } catch (err) {
      process.stderr.write(
        `[lint] ${svc.name}: dereference failed: ${(err as Error).message}\n`,
      );
      failed++;
      continue;
    }
    // Step 2: strict OpenAPI 3.x validate — often FAILS on real-world specs
    // that contain extras like `$schema` (JSON Schema 2020-12 keyword, not
    // valid in OpenAPI 3.0). Treat as warning unless --strict.
    try {
      // For URL sources reuse the already-fetched object (saves a round trip
      // and avoids double-auth). SwaggerParser.validate accepts an object.
      await SwaggerParser.validate(isUrl ? (derefApi as any) : openapiPath);
      process.stdout.write(`[lint] ${svc.name}: ok\n`);
    } catch (err) {
      const msg = (err as Error).message;
      if (args.strict) {
        process.stderr.write(`[lint] ${svc.name}: ${msg}\n`);
        failed++;
      } else {
        process.stdout.write(
          `[lint] ${svc.name}: ⚠ openapi-spec validation warning (dereference still works, sync will proceed):\n` +
            `        ${msg.split('\n').slice(0, 3).join('\n        ')}\n` +
            `        Use --strict to fail on these.\n`,
        );
      }
    }
  }
  return failed === 0 ? EXIT_OK : EXIT_BUSINESS;
}

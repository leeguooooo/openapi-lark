import { existsSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import { loadConfig, resolveOpenapiPath, ConfigError } from '../config/load.js';
import { EXIT_BUSINESS, EXIT_CONFIG, EXIT_OK } from '../types.js';

export interface LintArgs {
  service?: string;
  configPath: string;
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
    if (!existsSync(openapiPath)) {
      process.stderr.write(
        `[lint] ${svc.name}: openapi file not found at ${openapiPath}\n`,
      );
      failed++;
      continue;
    }
    try {
      await SwaggerParser.validate(openapiPath);
      process.stdout.write(`[lint] ${svc.name}: ok\n`);
    } catch (err) {
      process.stderr.write(`[lint] ${svc.name}: ${(err as Error).message}\n`);
      failed++;
    }
  }
  return failed === 0 ? EXIT_OK : EXIT_BUSINESS;
}

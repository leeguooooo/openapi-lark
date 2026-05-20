import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Persisted map of service name → docToken auto-created under a shared
 * parentDocToken. Lets subsequent sync reuse the same wiki child instead of
 * creating a new one each run.
 *
 * Stored at `.openapi-lark/auto-tokens.json` (gitignored). Per-project.
 *
 * Layout:
 *   {
 *     "version": 1,
 *     "services": {
 *       "<service-name>": {
 *         "docToken": "<wiki node token of the auto-created child>",
 *         "createdAt": "<iso-8601>",
 *         "parentDocToken": "<source parent>"
 *       }
 *     }
 *   }
 */

export const AUTO_TOKENS_VERSION = 1;
export const AUTO_TOKENS_FILENAME = 'auto-tokens.json';

export interface AutoTokenEntry {
  docToken: string;
  createdAt: string;
  parentDocToken: string;
}

export interface AutoTokensData {
  version: number;
  services: Record<string, AutoTokenEntry>;
}

export function autoTokensPath(basedir: string): string {
  return resolve(basedir, '.openapi-lark', AUTO_TOKENS_FILENAME);
}

export function loadAutoTokens(basedir: string): AutoTokensData {
  const path = autoTokensPath(basedir);
  if (!existsSync(path)) return { version: AUTO_TOKENS_VERSION, services: {} };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as AutoTokensData;
    if (parsed?.version !== AUTO_TOKENS_VERSION) {
      return { version: AUTO_TOKENS_VERSION, services: {} };
    }
    if (!parsed.services || typeof parsed.services !== 'object') {
      parsed.services = {};
    }
    return parsed;
  } catch {
    return { version: AUTO_TOKENS_VERSION, services: {} };
  }
}

export function saveAutoTokens(basedir: string, data: AutoTokensData): void {
  const path = autoTokensPath(basedir);
  mkdirSync(dirname(path), { recursive: true });
  const sorted: AutoTokensData = {
    version: AUTO_TOKENS_VERSION,
    services: Object.fromEntries(
      Object.keys(data.services)
        .sort()
        .map((k) => [k, data.services[k]]),
    ),
  };
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

export function lookupAutoToken(
  data: AutoTokensData,
  serviceName: string,
): AutoTokenEntry | undefined {
  return data.services[serviceName];
}

export function upsertAutoToken(
  data: AutoTokensData,
  serviceName: string,
  entry: AutoTokenEntry,
): void {
  data.services[serviceName] = entry;
}

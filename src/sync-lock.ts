import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Sync lockfile: maps docToken → sha256 of the most recently pushed markdown.
 * Used to skip docs +update calls when the rendered content is unchanged.
 *
 * Layout:
 *   {
 *     "version": 1,
 *     "services": {
 *       "<service-name>": {
 *         "<docToken>": {
 *           "sha256": "<64-hex>",
 *           "title": "<last-pushed-title>",
 *           "syncedAt": "<iso-8601>"
 *         }
 *       }
 *     }
 *   }
 */

export const LOCK_VERSION = 1;
export const DEFAULT_LOCK_FILENAME = 'sync-lock.json';

export interface DocLockEntry {
  sha256: string;
  title?: string;
  syncedAt: string;
}

export interface SyncLockData {
  version: number;
  services: Record<string, Record<string, DocLockEntry>>;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function lockfilePath(basedir: string, serviceName?: string): string {
  // Lockfile is global to the project (covers all services) for simplicity.
  void serviceName;
  return resolve(basedir, '.openapi-lark', DEFAULT_LOCK_FILENAME);
}

export function loadLock(basedir: string): SyncLockData {
  const path = lockfilePath(basedir);
  if (!existsSync(path)) {
    return { version: LOCK_VERSION, services: {} };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as SyncLockData;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== LOCK_VERSION) {
      // Newer/older lockfile — start fresh (don't risk corrupting)
      return { version: LOCK_VERSION, services: {} };
    }
    if (!parsed.services || typeof parsed.services !== 'object') {
      parsed.services = {};
    }
    return parsed;
  } catch {
    // Corrupted lockfile — start fresh
    return { version: LOCK_VERSION, services: {} };
  }
}

export function saveLock(basedir: string, data: SyncLockData): void {
  const path = lockfilePath(basedir);
  mkdirSync(dirname(path), { recursive: true });
  const sorted: SyncLockData = {
    version: LOCK_VERSION,
    services: Object.fromEntries(
      Object.keys(data.services)
        .sort()
        .map((sname) => {
          const docs = data.services[sname];
          return [
            sname,
            Object.fromEntries(
              Object.keys(docs)
                .sort()
                .map((t) => [t, docs[t]]),
            ),
          ];
        }),
    ),
  };
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

export function lookup(
  lock: SyncLockData,
  serviceName: string,
  docToken: string,
): DocLockEntry | undefined {
  return lock.services[serviceName]?.[docToken];
}

export function upsert(
  lock: SyncLockData,
  serviceName: string,
  docToken: string,
  entry: DocLockEntry,
): void {
  if (!lock.services[serviceName]) lock.services[serviceName] = {};
  lock.services[serviceName][docToken] = entry;
}

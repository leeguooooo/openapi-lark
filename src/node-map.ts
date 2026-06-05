import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Stable identity map: per-service map from "spec-derived identity key" →
 * wiki nodeToken. The identity key is the part that doesn't drift when the
 * human-readable title changes:
 *
 *   - tags:   tagId  →  nodeToken
 *   - groups: `${tagId}/${groupKey}` → nodeToken
 *   - leaves: `${METHOD} ${path}`    → nodeToken
 *
 * Used to recycle wiki nodes across summary / tagAlias / groupTitle changes
 * — so renaming "预测" to "创建预测（下注）" in the OpenAPI spec updates the
 * existing wiki node in place instead of creating a zombie.
 *
 * Stored at `.openapi-lark/node-map.json` (gitignored, per-project).
 *
 * On miss (first sync after upgrade, or cloning a repo whose maintainer hasn't
 * committed the file), the caller falls back to title-based pool matching —
 * see popLeafByEndpoint/popFromPool in sync-endpoint.ts.
 */

export const NODE_MAP_VERSION = 1;
export const NODE_MAP_FILENAME = 'node-map.json';

export interface ServiceNodeMap {
  tags: Record<string, string>;
  groups: Record<string, string>;
  leaves: Record<string, string>;
}

export interface NodeMapData {
  version: number;
  services: Record<string, ServiceNodeMap>;
}

export function nodeMapPath(basedir: string): string {
  return resolve(basedir, '.openapi-lark', NODE_MAP_FILENAME);
}

function emptyService(): ServiceNodeMap {
  return { tags: {}, groups: {}, leaves: {} };
}

export function loadNodeMap(basedir: string): NodeMapData {
  const path = nodeMapPath(basedir);
  if (!existsSync(path)) return { version: NODE_MAP_VERSION, services: {} };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as NodeMapData;
    if (parsed?.version !== NODE_MAP_VERSION) {
      return { version: NODE_MAP_VERSION, services: {} };
    }
    if (!parsed.services || typeof parsed.services !== 'object') {
      parsed.services = {};
    }
    for (const k of Object.keys(parsed.services)) {
      const s = parsed.services[k] ?? ({} as Partial<ServiceNodeMap>);
      parsed.services[k] = {
        tags: s.tags && typeof s.tags === 'object' ? s.tags : {},
        groups: s.groups && typeof s.groups === 'object' ? s.groups : {},
        leaves: s.leaves && typeof s.leaves === 'object' ? s.leaves : {},
      };
    }
    return parsed;
  } catch {
    return { version: NODE_MAP_VERSION, services: {} };
  }
}

export function saveNodeMap(basedir: string, data: NodeMapData): void {
  const path = nodeMapPath(basedir);
  mkdirSync(dirname(path), { recursive: true });
  const sorted: NodeMapData = {
    version: NODE_MAP_VERSION,
    services: Object.fromEntries(
      Object.keys(data.services)
        .sort()
        .map((sname) => {
          const s = data.services[sname];
          return [
            sname,
            {
              tags: sortObject(s.tags),
              groups: sortObject(s.groups),
              leaves: sortObject(s.leaves),
            },
          ];
        }),
    ),
  };
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

function sortObject(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

function ensureService(data: NodeMapData, svc: string): ServiceNodeMap {
  if (!data.services[svc]) data.services[svc] = emptyService();
  return data.services[svc];
}

/** Build the canonical leaf identity key from a method + path. */
export function endpointIdentity(method: string, path: string): string {
  return `${method.trim().toUpperCase()} ${path.trim()}`;
}

/**
 * Extract `METHOD path` from an arbitrary wiki node title. Used to recover
 * leaf identity on first sync after upgrade, when node-map.json is empty.
 *
 * Matches titles like:
 *   - "创建预测（下注） — POST /api/v1/predicts"  → "POST /api/v1/predicts"
 *   - "POST /api/v1/predicts"                    → "POST /api/v1/predicts"
 *   - "Some prose `GET /v1/x` more prose"        → "GET /v1/x"
 *
 * Returns null if no recognizable HTTP method + path is found.
 */
export function extractEndpointIdentity(title: string): string | null {
  const m = title.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/\S+)/i);
  if (!m) return null;
  // Strip trailing punctuation that the regex may have eaten (e.g. trailing
  // backtick from "`GET /x`"). Conservative: only strip a single closing
  // punctuation char.
  const path = m[2].replace(/[`)\]>,。、，]+$/u, '');
  return endpointIdentity(m[1], path);
}

export function getTagNode(
  data: NodeMapData,
  svc: string,
  tagId: string,
): string | undefined {
  return data.services[svc]?.tags[tagId];
}

export function setTagNode(
  data: NodeMapData,
  svc: string,
  tagId: string,
  nodeToken: string,
): void {
  ensureService(data, svc).tags[tagId] = nodeToken;
}

export function groupIdentity(tagId: string, groupKey: string): string {
  return `${tagId}/${groupKey}`;
}

export function getGroupNode(
  data: NodeMapData,
  svc: string,
  tagId: string,
  groupKey: string,
): string | undefined {
  return data.services[svc]?.groups[groupIdentity(tagId, groupKey)];
}

export function setGroupNode(
  data: NodeMapData,
  svc: string,
  tagId: string,
  groupKey: string,
  nodeToken: string,
): void {
  ensureService(data, svc).groups[groupIdentity(tagId, groupKey)] = nodeToken;
}

/**
 * Remove every node-map entry (across tags/groups/leaves) for a service that
 * points at `nodeToken`. Called after a zombie node is successfully pruned
 * (moved/deleted) so the next sync doesn't re-detect the now-gone node as a
 * zombie. Returns the number of entries removed (0 if none matched).
 */
export function removeNodeByToken(
  data: NodeMapData,
  svc: string,
  nodeToken: string,
): number {
  const s = data.services[svc];
  if (!s) return 0;
  let removed = 0;
  for (const bucket of [s.tags, s.groups, s.leaves]) {
    for (const key of Object.keys(bucket)) {
      if (bucket[key] === nodeToken) {
        delete bucket[key];
        removed++;
      }
    }
  }
  return removed;
}

export function getLeafNode(
  data: NodeMapData,
  svc: string,
  identity: string,
): string | undefined {
  return data.services[svc]?.leaves[identity];
}

export function setLeafNode(
  data: NodeMapData,
  svc: string,
  identity: string,
  nodeToken: string,
): void {
  ensureService(data, svc).leaves[identity] = nodeToken;
}

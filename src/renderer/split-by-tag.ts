/**
 * Split a dereferenced OpenAPI object into:
 *   - overview: same shape but with `paths: {}` (info + servers + components only)
 *   - byTag: { [tagId]: OpenAPI }, one per first tag of each operation
 *
 * Operations without a tag fall into a synthetic "untagged" bucket.
 *
 * Rules:
 *   - First tag wins (an operation with [room, admin] goes to "room")
 *   - components/securitySchemes/etc. are copied into every sub-api so they
 *     remain dereferenced and self-contained
 */

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

export interface SplitResult {
  overview: any;
  byTag: Record<string, any>;
}

/**
 * Build a sub-api template carrying common metadata but DROPPING components.schemas.
 *
 * Why drop schemas: swagger-parser.dereference() inlines every $ref into the
 * operations, so each sub-api's paths already contain fully-expanded schemas.
 * Keeping the full components.schemas in every sub-api duplicates the entire
 * schema catalog into every tag bucket (real-world: voice-room had 1.8MB of
 * components in each shard while paths only referenced a few schemas).
 *
 * We keep securitySchemes so the Authentication section still renders.
 */
function cloneShallow(api: any): any {
  const safeComponents = api.components
    ? {
        securitySchemes: api.components.securitySchemes,
        // intentionally drop schemas / parameters / responses / examples / headers
      }
    : undefined;
  return {
    openapi: api.openapi,
    info: api.info,
    servers: api.servers,
    components: safeComponents,
    security: api.security,
    tags: api.tags,
    externalDocs: api.externalDocs,
  };
}

export function splitByTag(api: any): SplitResult {
  const overview: any = { ...cloneShallow(api), paths: {} };
  const byTag: Record<string, any> = {};

  const paths = (api.paths ?? {}) as Record<string, any>;
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, op] of Object.entries(pathItem as Record<string, any>)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const tags: string[] = Array.isArray(op?.tags) && op.tags.length > 0 ? op.tags : [];
      const tagId = tags[0] ?? 'untagged';
      if (!byTag[tagId]) byTag[tagId] = { ...cloneShallow(api), paths: {} };
      if (!byTag[tagId].paths[pathKey]) byTag[tagId].paths[pathKey] = {};
      byTag[tagId].paths[pathKey][method] = op;
      // Carry over path-level shared fields (parameters, summary, description) once
      const sharedKeys = ['parameters', 'summary', 'description', 'servers'];
      for (const k of sharedKeys) {
        if ((pathItem as any)[k] !== undefined && byTag[tagId].paths[pathKey][k] === undefined) {
          byTag[tagId].paths[pathKey][k] = (pathItem as any)[k];
        }
      }
    }
  }

  return { overview, byTag };
}

/**
 * Resolve a tag id → display title. Uses provided aliases first, then the
 * `tags[]` description from openapi if available, else falls back to the id.
 */
export function titleForTag(
  tagId: string,
  api: any,
  aliases?: Record<string, string>,
): string {
  if (aliases?.[tagId]) return aliases[tagId];
  const t = (api.tags ?? []).find((x: any) => x?.name === tagId);
  if (t?.['x-display-name']) return t['x-display-name'];
  if (t?.description && typeof t.description === 'string' && t.description.length < 32) {
    return t.description;
  }
  return tagId;
}

export interface EndpointSlice {
  tagId: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  /** Sub-api containing only this one operation (everything else trimmed) */
  api: any;
}

/**
 * Split into one slice per (path, method) operation. Each slice carries the
 * full openapi metadata (info/servers/components/security) but `paths` contains
 * exactly one path with one method.
 *
 * Used by v1.3 per-endpoint tree mode: each slice → its own wiki node.
 */
/**
 * Endpoint slice carries a MINIMAL `info` (no description, no servers, no
 * securitySchemes). Reason: every leaf doc would otherwise duplicate the full
 * API preamble (info.description with 字段使用指南, Base URLs, Authentication)
 * — 167 times for voice-room, drowning the actual operation. We want each
 * leaf to be ONLY about its one endpoint.
 */
function endpointCloneShallow(api: any): any {
  const fullTitle = api.info?.title ?? '';
  return {
    openapi: api.openapi,
    info: {
      // Keep version so widdershins doesn't error, but suppress title/description
      // The lockTitleInMarkdown step will impose our own H1.
      title: '',
      version: api.info?.version ?? '1.0.0',
      description: '',
      'x-source-api-title': fullTitle, // preserved for debugging
    },
    // Intentionally drop: servers, components, security, tags (the preamble blocks)
  };
}

export function splitByEndpoint(api: any): EndpointSlice[] {
  const out: EndpointSlice[] = [];
  const paths = (api.paths ?? {}) as Record<string, any>;
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, op] of Object.entries(pathItem as Record<string, any>)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const tags: string[] = Array.isArray(op?.tags) && op.tags.length > 0 ? op.tags : [];
      const tagId = tags[0] ?? 'untagged';
      out.push({
        tagId,
        method: method.toUpperCase(),
        path: pathKey,
        operationId: typeof op?.operationId === 'string' ? op.operationId : undefined,
        summary: typeof op?.summary === 'string' ? op.summary : undefined,
        api: {
          ...endpointCloneShallow(api),
          paths: {
            [pathKey]: {
              [method]: op,
              // Carry path-level shared fields (parameters, etc.)
              ...Object.fromEntries(
                ['parameters', 'summary', 'description', 'servers']
                  .filter((k) => (pathItem as any)[k] !== undefined)
                  .map((k) => [k, (pathItem as any)[k]]),
              ),
            },
          },
        },
      });
    }
  }
  return out;
}

/**
 * Generate a display title for one endpoint slice.
 *
 * Preferred format: "<summary> — <METHOD> <path>"
 * When summary is absent or excessively long, fall back to "<METHOD> <path>".
 *
 * Rationale: human language goes first so users scanning a flat list of
 * wiki nodes (especially in Chinese-only context) recognize endpoints by
 * intent, not by URL pattern. Method/path becomes a disambiguation suffix.
 */
export function titleForEndpoint(slice: EndpointSlice): string {
  if (slice.summary && slice.summary.length <= 40) {
    return `${slice.summary} — ${slice.method} ${slice.path}`;
  }
  return `${slice.method} ${slice.path}`;
}

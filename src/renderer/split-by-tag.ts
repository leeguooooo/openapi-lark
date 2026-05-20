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

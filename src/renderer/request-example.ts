/**
 * Synthesize a copy-pasteable `curl` 「请求示例」 for a single operation.
 *
 * Inputs used:
 *  - METHOD + path (path-params filled from their example / synthesized value)
 *  - required query params (filled likewise)
 *  - the auth header from the operation's resolved security scheme
 *  - a JSON request body (synthesized from schema) for write methods
 *
 * Mirrors example-from-schema.ts for value synthesis.
 */

import { generateExample } from './example-from-schema.js';

function isObj(x: unknown): x is Record<string, any> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

const BASE_PLACEHOLDER = 'https://api.example.com';

/** A single example scalar for a parameter, preferring its declared example. */
function paramValue(p: any): string {
  if (p?.example !== undefined) return String(p.example);
  if (isObj(p?.schema)) {
    if (p.schema.example !== undefined) return String(p.schema.example);
    if (Array.isArray(p.schema.enum) && p.schema.enum.length > 0) {
      return String(p.schema.enum[0]);
    }
    const v = generateExample(p.schema);
    if (v !== null && v !== undefined && typeof v !== 'object') return String(v);
  }
  return `<${p?.name ?? 'value'}>`;
}

/** Resolve the auth header line(s) for the operation's effective security. */
function authHeaderArgs(op: any, api: any): string[] {
  const schemes = isObj(api?.components?.securitySchemes)
    ? api.components.securitySchemes
    : {};
  let requirements: any[] | undefined;
  if (Array.isArray(op?.security)) requirements = op.security;
  else if (Array.isArray(api?.security)) requirements = api.security;
  if (!requirements || requirements.length === 0) return [];

  // Use the FIRST requirement object (the primary AND-set).
  const first = requirements.find((r) => isObj(r) && Object.keys(r).length > 0);
  if (!isObj(first)) return [];

  const args: string[] = [];
  for (const name of Object.keys(first)) {
    const scheme = schemes[name];
    if (!isObj(scheme)) continue;
    if (scheme.type === 'apiKey' && scheme.in === 'header') {
      args.push(`-H '${scheme.name ?? name}: <key>'`);
    } else if (scheme.type === 'http') {
      const sch = String(scheme.scheme ?? '').toLowerCase();
      if (sch === 'bearer') args.push(`-H 'Authorization: Bearer <token>'`);
      else if (sch === 'basic') args.push(`-H 'Authorization: Basic <base64>'`);
    }
    // apiKey-in-query is appended to the URL by the caller via query params; skip
    // here to avoid duplicating. oauth2/openIdConnect omitted (no single header).
  }
  return args;
}

/** Pick base URL from servers[0] when present, else a placeholder. */
function baseUrl(api: any): string {
  const servers = api?.servers;
  if (Array.isArray(servers) && servers.length > 0 && typeof servers[0]?.url === 'string') {
    const u = servers[0].url.trim();
    if (u && /^https?:\/\//.test(u)) return u.replace(/\/$/, '');
  }
  return BASE_PLACEHOLDER;
}

/** JSON content type from the request body, defaults to application/json. */
function requestBodySchema(op: any): any | null {
  const content = op?.requestBody?.content;
  if (!isObj(content)) return null;
  const json = content['application/json'];
  if (isObj(json) && isObj(json.schema)) return json.schema;
  return null;
}

/**
 * Build the curl command (string, no fences) for the operation. `path` is the
 * raw OpenAPI path template (`/x/{id}`). Returns null when inputs are unusable.
 */
export function buildCurl(method: string, path: string, op: any, api: any): string | null {
  if (!method || !path) return null;
  const verb = method.toUpperCase();
  const params = Array.isArray(op?.parameters) ? op.parameters : [];

  // Fill path params from example/synthesized value.
  let filledPath = path;
  for (const p of params) {
    if (p?.in === 'path' && typeof p.name === 'string') {
      filledPath = filledPath.replace(
        new RegExp(`\\{${p.name}\\}`, 'g'),
        encodeURIComponent(paramValue(p)),
      );
    }
  }
  // Any remaining unfilled {x} → placeholder
  filledPath = filledPath.replace(/\{([^}]+)\}/g, (_m, n) => encodeURIComponent(`<${n}>`));

  // Required query params (+ apiKey-in-query schemes).
  const query: string[] = [];
  for (const p of params) {
    if (p?.in === 'query' && p.required && typeof p.name === 'string') {
      query.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(paramValue(p))}`);
    }
  }
  const schemes = isObj(api?.components?.securitySchemes) ? api.components.securitySchemes : {};
  let requirements: any[] | undefined;
  if (Array.isArray(op?.security)) requirements = op.security;
  else if (Array.isArray(api?.security)) requirements = api.security;
  const firstReq = requirements?.find((r) => isObj(r) && Object.keys(r).length > 0);
  if (isObj(firstReq)) {
    for (const name of Object.keys(firstReq)) {
      const s = schemes[name];
      if (isObj(s) && s.type === 'apiKey' && s.in === 'query') {
        query.push(`${encodeURIComponent(s.name ?? name)}=<key>`);
      }
    }
  }

  const url = `${baseUrl(api)}${filledPath}${query.length ? '?' + query.join('&') : ''}`;

  const lines: string[] = [];
  // -X only for non-GET to keep GET examples clean.
  lines.push(verb === 'GET' ? `curl '${url}'` : `curl -X ${verb} '${url}'`);
  for (const a of authHeaderArgs(op, api)) lines.push(`  ${a}`);

  const bodySchema = requestBodySchema(op);
  if (bodySchema && verb !== 'GET' && verb !== 'HEAD') {
    lines.push(`  -H 'Content-Type: application/json'`);
    const body = generateExample(bodySchema);
    if (body !== null && body !== undefined) {
      const json = JSON.stringify(body);
      lines.push(`  -d '${json.replace(/'/g, "'\\''")}'`);
    }
  }

  return lines.join(' \\\n');
}

/**
 * Append a 「请求示例」 fenced curl block. Endpoint-mode only (single op slice).
 * Inserts before the 响应示例 block if present, else appends at end.
 */
export function injectRequestExample(md: string, api: any): string {
  const paths = isObj(api?.paths) ? api.paths : {};
  const HTTP = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  let found: { method: string; path: string; op: any } | null = null;
  for (const [p, pathItem] of Object.entries(paths)) {
    if (!isObj(pathItem)) continue;
    for (const [method, o] of Object.entries(pathItem as Record<string, any>)) {
      if (!HTTP.has(method.toLowerCase())) continue;
      if (isObj(o)) {
        found = { method, path: p, op: o };
        break;
      }
    }
    if (found) break;
  }
  if (!found) return md;

  const curl = buildCurl(found.method, found.path, found.op, api);
  if (!curl) return md;
  const block = `\n### 请求示例\n\n\`\`\`bash\n${curl}\n\`\`\`\n`;

  // Insert just before the 响应示例 heading so request precedes response.
  const idx = md.indexOf('### 响应示例');
  if (idx >= 0) {
    return md.slice(0, idx) + block.trimStart() + '\n' + md.slice(idx);
  }
  return md.trimEnd() + '\n' + block;
}

/**
 * Resolve an operation's effective security requirement and render a plain-中文
 * 「鉴权」 section.
 *
 * Why: widdershins emits a global `# Authentication` block that lists EVERY
 * scheme in the spec — a reader of one endpoint cannot tell which header THIS
 * endpoint needs. We resolve the operation-level `security` (falling back to the
 * spec-global `security`), translate each scheme into a concrete instruction
 * (e.g. "需在请求头携带 `X-Api-Key: <key>`"), and inject it right after the
 * METHOD/path line.
 */

function isObj(x: unknown): x is Record<string, any> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** Describe one named security scheme in plain Chinese. */
function describeScheme(name: string, scheme: any): string {
  if (!isObj(scheme)) return `需满足安全方案 \`${name}\``;
  const type = scheme.type;
  if (type === 'apiKey') {
    const loc = scheme.in;
    const keyName = scheme.name ?? name;
    if (loc === 'header') return `需在请求头携带 \`${keyName}: <key>\``;
    if (loc === 'query') return `需在查询参数携带 \`${keyName}=<key>\``;
    if (loc === 'cookie') return `需在 Cookie 携带 \`${keyName}=<key>\``;
    return `需携带 API Key \`${keyName}\``;
  }
  if (type === 'http') {
    const sch = String(scheme.scheme ?? '').toLowerCase();
    if (sch === 'bearer') {
      const fmt = scheme.bearerFormat ? `（${scheme.bearerFormat}）` : '';
      return `需在 \`Authorization: Bearer <token>\` 头携带令牌${fmt}`;
    }
    if (sch === 'basic') return '需在 `Authorization: Basic <base64(user:pass)>` 头携带凭证';
    return `需在 \`Authorization\` 头使用 ${scheme.scheme} 方案`;
  }
  if (type === 'oauth2') return `需 OAuth2 授权（方案 \`${name}\`）`;
  if (type === 'openIdConnect') return `需 OpenID Connect 授权（方案 \`${name}\`）`;
  return `需满足安全方案 \`${name}\``;
}

/**
 * Compute the 鉴权 section body for a single operation. Returns null when no
 * section should be rendered (shouldn't happen — we always render something).
 *
 *  - operation `security: []` (empty array)  → 无需鉴权
 *  - operation `security` present            → use it
 *  - else fall back to global `security`     → use it
 *  - neither present                         → 无需鉴权
 *
 * Multiple requirement objects in the array = OR (any one satisfies). Multiple
 * schemes inside one object = AND (all required together).
 */
export function securitySectionBody(op: any, api: any): string {
  const schemes = isObj(api?.components?.securitySchemes)
    ? api.components.securitySchemes
    : {};

  let requirements: any[] | undefined;
  if (Array.isArray(op?.security)) {
    requirements = op.security; // includes the explicit `[]` (auth disabled) case
  } else if (Array.isArray(api?.security)) {
    requirements = api.security;
  }

  if (!requirements || requirements.length === 0) {
    return '无需鉴权。';
  }

  // Each requirement object → AND of its schemes. Across objects → OR.
  const alternatives: string[] = [];
  for (const req of requirements) {
    if (!isObj(req)) continue;
    const keys = Object.keys(req);
    if (keys.length === 0) {
      // `{}` requirement = optional/no auth for this alternative
      alternatives.push('无需鉴权');
      continue;
    }
    const ands = keys.map((k) => describeScheme(k, schemes[k]));
    alternatives.push(ands.join('，且'));
  }

  if (alternatives.length === 0) return '无需鉴权。';
  if (alternatives.length === 1) return alternatives[0] + '。';
  // OR: list the options
  return (
    '以下任一方式均可：\n' +
    alternatives.map((a) => `- ${a}`).join('\n')
  );
}

/**
 * How many distinct security ALTERNATIVES (OR-options) the operation resolves to.
 *  - 0  → no auth (无需鉴权)
 *  - 1  → a single requirement (possibly several AND-ed schemes counted as one
 *         alternative — the callout's one-liner can carry "A，且 B")
 *  - ≥2 → multiple OR-options (callout can't list them; keep the full section)
 *
 * Used for the v0.7 鉴权 dedup: when the callout already shows the only option,
 * the standalone `### 鉴权` section is redundant and is dropped.
 */
export function securityAlternativeCount(op: any, api: any): number {
  let requirements: any[] | undefined;
  if (Array.isArray(op?.security)) {
    requirements = op.security;
  } else if (Array.isArray(api?.security)) {
    requirements = api.security;
  }
  if (!requirements) return 0;
  // Count requirement objects that demand auth. An empty `{}` requirement means
  // "no auth for this alternative" and is not a distinct auth instruction.
  return requirements.filter((r) => isObj(r) && Object.keys(r).length > 0).length;
}

/**
 * Inject the 「鉴权」 section into the rendered markdown right after the
 * METHOD/path code line (`` `GET /api/...` ``). Falls back to inserting after
 * the operation description / before the 参数 section when the code line isn't
 * found. Endpoint-mode only (one operation per doc).
 *
 * Always emits the section into the MARKDOWN (so the markdown-fallback push still
 * carries auth). The v0.7 dedup — dropping this section when a single-scheme
 * endpoint's top callout already states the auth — is applied later in the XML
 * transform (markdown-to-xml.ts), because the callout only exists in the XML
 * output; the markdown path has no callout and must keep the section.
 */
export function injectSecuritySection(md: string, api: any): string {
  const paths = isObj(api?.paths) ? api.paths : {};
  const HTTP = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  let op: any = null;
  for (const pathItem of Object.values(paths)) {
    if (!isObj(pathItem)) continue;
    for (const [method, o] of Object.entries(pathItem as Record<string, any>)) {
      if (!HTTP.has(method.toLowerCase())) continue;
      if (isObj(o)) {
        op = o;
        break;
      }
    }
    if (op) break;
  }
  if (!op) return md;

  const body = securitySectionBody(op, api);
  const section = `\n### 鉴权\n\n${body}\n`;

  // Prefer inserting right after the `` `METHOD /path` `` line.
  const lines = md.split('\n');
  const codeLineIdx = lines.findIndex((l) =>
    /^\s*`(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+\/[^`]*`\s*$/.test(l),
  );
  if (codeLineIdx >= 0) {
    lines.splice(codeLineIdx + 1, 0, section);
    return lines.join('\n');
  }

  // Fallback: insert before the first 参数/响应 heading.
  const headingIdx = lines.findIndex((l) => /^#{2,6}\s+(参数|响应)\s*$/.test(l));
  if (headingIdx >= 0) {
    lines.splice(headingIdx, 0, section.trimStart() + '\n');
    return lines.join('\n');
  }

  // Last resort: append.
  return md.trimEnd() + '\n' + section;
}

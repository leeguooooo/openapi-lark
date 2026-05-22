import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { EXIT_CONFIG, EXIT_OK } from '../types.js';

/**
 * Cheap framework sniff for the diagnostic message printed when `--openapi`
 * points at a missing local file. Helps users who don't yet have an OpenAPI
 * source figure out how to expose one from their stack. Reads-only; never
 * throws (one bad project shouldn't break init).
 */
export function diagnoseOpenapiSource(basedir: string): string[] {
  const hints: string[] = [];
  const pkgPath = resolve(basedir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (deps['chanfana'])
        hints.push('detected chanfana — your Worker already exposes /openapi.json; use the deploy URL as services[].openapi');
      if (deps['hono'])
        hints.push('detected Hono — add @hono/zod-openapi (OpenAPIHono) and serve doc(/openapi.json); then use that URL as services[].openapi');
      if (deps['@hono/zod-openapi'])
        hints.push('detected @hono/zod-openapi — call app.doc("/openapi.json", {...}) and point services[].openapi at that URL');
      if (deps['fastify'])
        hints.push('detected Fastify — add @fastify/swagger to expose /openapi.json');
      if (deps['@nestjs/core'])
        hints.push('detected NestJS — add @nestjs/swagger and call SwaggerModule.createDocument(); /api-docs-json is the default URL');
      if (deps['express'] && !deps['swagger-jsdoc'])
        hints.push('detected Express (no swagger-jsdoc) — add swagger-jsdoc + swagger-ui-express to expose an OpenAPI spec');
      if (deps['tsoa'])
        hints.push('detected tsoa — run `tsoa spec` then point services[].openapi at the generated swagger.json');
    } catch {
      /* unreadable package.json — ignore */
    }
  }
  if (existsSync(resolve(basedir, 'requirements.txt')) || existsSync(resolve(basedir, 'pyproject.toml'))) {
    hints.push('detected Python project — FastAPI exposes /openapi.json by default; for Flask use flasgger; for Django use drf-spectacular');
  }
  if (existsSync(resolve(basedir, 'go.mod'))) {
    hints.push('detected Go project — common OpenAPI generators: huma, swaggo/swag (`swag init` → docs/swagger.json), or gin-swagger');
  }
  if (existsSync(resolve(basedir, 'Cargo.toml'))) {
    hints.push('detected Rust project — utoipa generates OpenAPI from axum/actix handlers');
  }
  // docs/ folder check runs unconditionally — a Hono project with hand-written
  // docs/*.md still needs both hints (here's how to generate OpenAPI from
  // your stack AND here's why your existing docs/ won't be picked up).
  if (existsSync(resolve(basedir, 'docs'))) {
    hints.push(
      "found a docs/ folder — openapi-lark needs an OpenAPI spec (JSON/YAML), not markdown; we can't auto-convert. If your docs are the source of truth, generate openapi.json from them with a script and point services[].openapi at the output",
    );
  }
  return hints;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Best-effort read of `info.title` from a local OpenAPI file.
 * Returns null when the file is missing / unparseable / has no title.
 * Never throws — init must continue even if the spec is broken or remote.
 */
export function readOpenapiTitle(absPath: string): string | null {
  try {
    if (!existsSync(absPath)) return null;
    const raw = readFileSync(absPath, 'utf8');
    const parsed = absPath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
    const title = parsed?.info?.title;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

export interface InitArgs {
  name: string;
  openapi: string;
  docUrl: string;
  configPath: string;
  /** Inject (or refresh) the openapi-lark CLAUDE.md section guiding AI agents
   *  to read the spec file + search wiki via lark-cli. Default true. */
  injectClaudeMd?: boolean;
}

/**
 * CLAUDE.md section injected by `openapi-lark init`. Hint AI agents on
 * how to consume this project's API spec without us adding any runtime
 * infrastructure. Two markers bracket a managed block so re-running init
 * is idempotent and users can hand-edit outside the block.
 *
 * Format choice: terse, action-oriented. No emojis (per global CLAUDE.md
 * style rule). One section, no nested headers — keeps it cheap context-wise.
 */
const CLAUDE_MD_BEGIN = '<!-- openapi-lark:claude-md:begin -->';
const CLAUDE_MD_END = '<!-- openapi-lark:claude-md:end -->';

export function buildClaudeMdSection(args: {
  serviceName: string;
  openapi: string;
  docUrl: string;
}): string {
  const isUrl = isHttpUrl(args.openapi);
  const specLine = isUrl
    ? `OpenAPI 源：\`${args.openapi}\`（HTTP URL，每次 sync 时拉取）`
    : `OpenAPI 源：\`${args.openapi}\`（本地文件，直接 Read 就能拿到 paths + components.schemas）`;
  const readHint = isUrl
    ? `- 拉取实时 spec：\`curl -s '${args.openapi}' | jq .\`（或在浏览器打开看）`
    : `- 直接 Read \`${args.openapi}\`：有 \`paths\` + \`components.schemas\` 双轨，遇到 \`$ref\` 跟过去就行`;
  return [
    CLAUDE_MD_BEGIN,
    '## API spec (openapi-lark 自动注入；本块被 openapi-lark init 维护，不要在 begin/end 之间手改)',
    '',
    `本项目接口文档已通过 openapi-lark 同步到飞书 wiki（service: \`${args.serviceName}\`）：`,
    '',
    `- ${specLine}`,
    `- 飞书 wiki 镜像：${args.docUrl}`,
    '',
    '### AI 查接口的两条路',
    '',
    readHint,
    `- 搜飞书 wiki：\`lark-cli drive +search --query "<关键字>"\`（path / 中文 summary / 单词都能命中，返回带 highlighted snippet）`,
    '- 拿单个文档全文：`lark-cli docs +fetch --doc <token> --api-version v2`',
    '',
    '### spec 改了之后',
    '',
    '- 重新 sync 推到飞书：`openapi-lark sync`',
    '- 加 git hook 自动同步：`openapi-lark install-hook`',
    '',
    CLAUDE_MD_END,
  ].join('\n');
}

/**
 * Inject or refresh the openapi-lark managed block in CLAUDE.md (at basedir).
 * Idempotent: if the block markers exist, replace between them. Otherwise
 * append to CLAUDE.md (creating it if absent).
 *
 * Returns the action taken so the caller can log it.
 */
export function injectClaudeMd(args: {
  basedir: string;
  serviceName: string;
  openapi: string;
  docUrl: string;
}): 'created' | 'updated' | 'unchanged' {
  const claudeMdPath = resolve(args.basedir, 'CLAUDE.md');
  const newBlock = buildClaudeMdSection({
    serviceName: args.serviceName,
    openapi: args.openapi,
    docUrl: args.docUrl,
  });

  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, newBlock + '\n', 'utf8');
    return 'created';
  }

  const existing = readFileSync(claudeMdPath, 'utf8');
  const beginIdx = existing.indexOf(CLAUDE_MD_BEGIN);
  const endIdx = existing.indexOf(CLAUDE_MD_END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + CLAUDE_MD_END.length);
    const next = before + newBlock + after;
    if (next === existing) return 'unchanged';
    writeFileSync(claudeMdPath, next, 'utf8');
    return 'updated';
  }

  // No managed block yet — append. Preserve user's content as-is above.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(claudeMdPath, existing + sep + newBlock + '\n', 'utf8');
  return 'updated';
}

/**
 * Token shape sanity: feishu doc tokens are typically alphanumeric (sometimes with
 * underscores/dashes), 16+ chars. We don't enforce a strict regex (forward compat),
 * just minimum length + safe charset.
 */
function looksLikeDocToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{8,}$/.test(s);
}

/**
 * Extract docToken from a Feishu docx URL.
 *
 * Supported markers (broaden as feishu adds product types):
 *   docx / docs / wiki / sheets / base / minutes / mindnote / okr
 *
 * Marker matching only — no fallback. Rationale (codex round-6 Q3): paths like
 * `feishu.cn/spaces/manage/<UUID>` would otherwise leak admin/share IDs into
 * the config as if they were docTokens. Users who hit an unrecognised marker
 * should manually paste the docToken and file an issue to expand the marker list.
 *
 * Trailing query/fragment is stripped.
 */
export function extractDocToken(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const trusted =
      host.endsWith('feishu.cn') ||
      host.endsWith('larksuite.com') ||
      host.endsWith('larkoffice.com');
    if (!trusted) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const markers = new Set([
      'docx',
      'docs',
      'wiki',
      'sheets',
      'base',
      'minutes',
      'mindnote',
      'okr',
    ]);
    for (let i = 0; i < parts.length - 1; i++) {
      if (markers.has(parts[i])) {
        const candidate = parts[i + 1];
        if (candidate && looksLikeDocToken(candidate)) return candidate;
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function runInit(args: InitArgs): Promise<number> {
  const docToken = extractDocToken(args.docUrl);
  if (!docToken) {
    process.stderr.write(
      `[init] could not extract docToken from URL: ${args.docUrl}\n` +
        `       Supported URL shapes (must contain one of these path markers):\n` +
        `         https://feishu.cn/docx/<token>\n` +
        `         https://feishu.cn/wiki/<token>\n` +
        `         https://feishu.cn/docs/<token>\n` +
        `         https://feishu.cn/sheets/<token>\n` +
        `         https://feishu.cn/base/<token>\n` +
        `       If your URL doesn't fit any of the above, paste the docToken directly\n` +
        `       into .openapi-lark.yaml and open an issue to expand the marker list.\n`,
    );
    return EXIT_CONFIG;
  }

  const configPath = resolve(args.configPath);
  let doc: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  }

  if (!doc.engines || typeof doc.engines !== 'object') {
    // `auth check` was added in lark-cli 1.0.34; doctor's real scope preflight
    // depends on it. Lower constraints will work but with degraded UX (doctor
    // marks scope check as skipped instead of pass/fail).
    doc.engines = { larkCli: '>=1.0.34' };
  }
  const services = Array.isArray(doc.services)
    ? (doc.services as Array<Record<string, unknown>>)
    : [];
  const idx = services.findIndex((s) => s.name === args.name);
  // Defaults aligned with SKILL.md recommendation:
  //   - mode: endpoint  (one wiki node per (path, method) — best for cross-project lookup)
  //   - parentTitle    (locks wiki node title against accidental edits; only set when we can
  //                     read it from info.title — URL openapi / missing file → skip silently)
  const entry: Record<string, unknown> = {
    name: args.name,
    openapi: args.openapi,
    mode: 'endpoint',
    docToken,
  };
  // For local file paths, sniff title from info.title and run a project-source
  // diagnostic if the file is missing (so the user has a path forward).
  // URL sources skip both — we don't fetch in init.
  let title: string | null = null;
  if (!isHttpUrl(args.openapi)) {
    const openapiAbs = resolve(args.openapi);
    title = readOpenapiTitle(openapiAbs);
    if (title) entry.parentTitle = title;
    if (!existsSync(openapiAbs)) {
      // Diagnose against the config's basedir (where the yaml will be written).
      // That's the project root the user is running init from.
      const basedir = dirname(resolve(args.configPath));
      const hints = diagnoseOpenapiSource(basedir);
      process.stderr.write(
        `[init] ⚠ openapi source "${args.openapi}" not found at ${openapiAbs}\n` +
          `       The .openapi-lark.yaml will still be written so you can fix the path later.\n` +
          (hints.length > 0
            ? `       Suggestions for this project:\n` +
              hints.map((h) => `         - ${h}\n`).join('')
            : `       Or use a runtime URL: services[].openapi: https://your-app.example.com/openapi.json\n`),
      );
    }
  }
  if (idx >= 0) {
    // Preserve user-edited keys not in our defaults (e.g. render.engine)
    services[idx] = { ...services[idx], ...entry };
  } else {
    services.push(entry);
  }
  doc.services = services;

  const yaml = stringifyYaml(doc, { lineWidth: 0 });
  writeFileSync(configPath, yaml, 'utf8');
  process.stdout.write(
    `[init] wrote ${configPath}\n` +
      `       service "${args.name}" -> docToken ${docToken}\n` +
      `       defaults: mode=endpoint${title ? `, parentTitle="${title}"` : ''}\n` +
      `       review engines.larkCli before running sync\n`,
  );

  // CLAUDE.md injection: default on. The hint section is tiny (~25 lines) and
  // saves users from explaining "where's the spec / how to query feishu" to
  // every AI agent that touches the repo. Opt out via --no-claude-md.
  if (args.injectClaudeMd !== false) {
    try {
      const basedir = dirname(resolve(args.configPath));
      const action = injectClaudeMd({
        basedir,
        serviceName: args.name,
        openapi: args.openapi,
        docUrl: args.docUrl,
      });
      process.stdout.write(`[init] CLAUDE.md ${action}\n`);
    } catch (err) {
      // Non-fatal — CLAUDE.md injection failure shouldn't break init.
      process.stderr.write(
        `[init] warning: CLAUDE.md injection failed: ${(err as Error).message}\n`,
      );
    }
  }
  return EXIT_OK;
}

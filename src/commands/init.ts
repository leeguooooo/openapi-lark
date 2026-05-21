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
  // Heuristic: docs/ folder full of .md but no openapi → likely hand-written docs
  if (existsSync(resolve(basedir, 'docs')) && hints.length === 0) {
    hints.push('found a docs/ folder — openapi-lark needs an OpenAPI spec (JSON/YAML), not markdown; we can\'t auto-convert');
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
    doc.engines = { larkCli: '>=0.1.0' };
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
  return EXIT_OK;
}

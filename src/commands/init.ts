import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { EXIT_CONFIG, EXIT_OK } from '../types.js';

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
  const entry: Record<string, unknown> = {
    name: args.name,
    openapi: args.openapi,
    docToken,
  };
  if (idx >= 0) {
    services[idx] = entry;
  } else {
    services.push(entry);
  }
  doc.services = services;

  const yaml = stringifyYaml(doc, { lineWidth: 0 });
  writeFileSync(configPath, yaml, 'utf8');
  process.stdout.write(
    `[init] wrote ${configPath}\n` +
      `       service "${args.name}" -> docToken ${docToken}\n` +
      `       review engines.larkCli before running sync\n`,
  );
  return EXIT_OK;
}

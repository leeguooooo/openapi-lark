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
 * Extract docToken from a Feishu docx URL.
 *
 * Supported formats:
 *   https://feishu.cn/docx/<token>
 *   https://feishu.cn/wiki/<token>
 *   https://feishu.cn/docs/<token>
 *   https://*.larksuite.com/docx/<token>
 *   https://*.larkoffice.com/...
 *
 * Trailing query/fragment is stripped.
 */
export function extractDocToken(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (
      !host.endsWith('feishu.cn') &&
      !host.endsWith('larksuite.com') &&
      !host.endsWith('larkoffice.com')
    ) {
      return null;
    }
    const parts = u.pathname.split('/').filter(Boolean);
    // Look for known segment markers
    const markers = new Set(['docx', 'docs', 'wiki', 'sheets', 'base']);
    for (let i = 0; i < parts.length - 1; i++) {
      if (markers.has(parts[i])) {
        return parts[i + 1] || null;
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
        `       Expected something like https://feishu.cn/docx/<token>\n`,
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

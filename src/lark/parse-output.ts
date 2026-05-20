/**
 * Parse `lark docs +update` output. v1 supports two modes:
 *   1. --json: stdout is JSON, extract `url` / `docUrl` / `doc_url`
 *   2. plain text fallback: regex-extract the first feishu.cn / larksuite.com URL
 *
 * Returns `null` if no URL can be found (caller treats this as a warning, not failure).
 */

export interface ParsedPushOutput {
  url: string | null;
  raw: string;
  jsonMode: boolean;
}

const URL_REGEX =
  /https?:\/\/[a-z0-9.\-]*(feishu\.cn|larksuite\.com|larkoffice\.com)[^\s'")\]]*/i;

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith('{') || t.startsWith('[');
}

function findUrlInValue(v: unknown): string | null {
  if (typeof v === 'string') {
    const m = v.match(URL_REGEX);
    if (m) return m[0];
    return null;
  }
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) {
      const found = findUrlInValue(child);
      if (found) return found;
    }
  }
  return null;
}

export function parsePushOutput(stdout: string): ParsedPushOutput {
  const raw = stdout;
  if (looksLikeJson(stdout)) {
    try {
      const parsed = JSON.parse(stdout) as unknown;
      // Try common field names first, then deep search
      const candidate =
        (parsed as any)?.url ??
        (parsed as any)?.docUrl ??
        (parsed as any)?.doc_url ??
        (parsed as any)?.data?.url ??
        (parsed as any)?.data?.docUrl ??
        (parsed as any)?.data?.doc_url ??
        findUrlInValue(parsed);
      const url =
        typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
      return { url, raw, jsonMode: true };
    } catch {
      // fall through to regex
    }
  }
  const m = stdout.match(URL_REGEX);
  return { url: m ? m[0] : null, raw, jsonMode: false };
}

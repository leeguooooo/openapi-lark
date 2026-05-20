export interface ServiceConfig {
  name: string;
  openapi: string;
  docToken: string;
  /** 'single' (default): overwrite docToken's docx with full rendered output.
   *  'tree': treat docToken as a wiki node; group endpoints by first tag, push
   *  the overview to the parent docx, and create/update child wiki nodes per tag. */
  mode?: 'single' | 'tree';
  /** Map tag id → display title for child node names */
  tagAliases?: Record<string, string>;
  /** Only sync these tags (default: all tags found in openapi) */
  includeTags?: string[];
  /** Skip these tags */
  excludeTags?: string[];
  render?: {
    engine: 'widdershins' | 'native';
  };
}

export interface Config {
  engines: {
    larkCli: string;
  };
  services: ServiceConfig[];
  extends?: string;
  pushTimeoutMs?: number;
  maxResolvedSizeBytes?: number;
  /** Binary name in PATH; defaults to "lark-cli". Override e.g. "lark" or absolute path. */
  larkBin?: string;
  /** Max md size in bytes; pre-push check fails fast with size guidance.
   *  Default 600 KB (well below the 1 MB lark-cli server-time-out boundary observed in ap-southeast-1). */
  maxPushBytes?: number;
}

export interface ServiceResult {
  service: string;
  status: 'ok' | 'failed' | 'warning' | 'skipped';
  docUrl?: string;
  durationMs: number;
  reason?: string;
}

export type Engine = 'widdershins' | 'native';

export const EXIT_OK = 0;
export const EXIT_BUSINESS = 1;
export const EXIT_CONFIG = 2;
export const EXIT_ENV = 3;

export const DEFAULT_PUSH_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RESOLVED_SIZE_BYTES = 50 * 1024 * 1024;
export const MIN_MAX_RESOLVED_SIZE_BYTES = 1 * 1024 * 1024;
export const MIN_PUSH_TIMEOUT_MS = 5_000;
/** Real-world calibration (2026-05-20, lark-cli v1.0.32, ap-southeast-1):
 *  500 KB markdown — success
 *  1 MB markdown   — server time out
 *  Default cutoff: 600 KB, leave headroom; configurable via maxPushBytes. */
export const DEFAULT_MAX_PUSH_BYTES = 600 * 1024;
export const MIN_MAX_PUSH_BYTES = 1024;

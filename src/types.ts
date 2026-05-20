export interface ServiceConfig {
  name: string;
  openapi: string;
  docToken: string;
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

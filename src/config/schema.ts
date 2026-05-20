import { z } from 'zod';
import {
  DEFAULT_PUSH_TIMEOUT_MS,
  DEFAULT_MAX_RESOLVED_SIZE_BYTES,
  MIN_MAX_RESOLVED_SIZE_BYTES,
  MIN_PUSH_TIMEOUT_MS,
} from '../types.js';

export const RenderSchema = z.object({
  engine: z.enum(['widdershins', 'native']).default('widdershins'),
});

export const ServiceSchema = z.object({
  name: z.string().min(1, 'service.name is required'),
  openapi: z.string().min(1, 'service.openapi is required'),
  docToken: z.string().min(1, 'service.docToken is required (cannot be empty)'),
  render: RenderSchema.optional(),
});

export const ConfigSchema = z.object({
  engines: z
    .object({
      larkCli: z
        .string()
        .min(1, 'engines.larkCli is required; pin a version range like ">=1.2.3"'),
    })
    .strict(),
  services: z.array(ServiceSchema).min(1, 'at least one service must be configured'),
  extends: z.string().optional(),
  pushTimeoutMs: z
    .number()
    .int()
    .min(MIN_PUSH_TIMEOUT_MS, `pushTimeoutMs must be >= ${MIN_PUSH_TIMEOUT_MS}`)
    .default(DEFAULT_PUSH_TIMEOUT_MS),
  maxResolvedSizeBytes: z
    .number()
    .int()
    .min(
      MIN_MAX_RESOLVED_SIZE_BYTES,
      `maxResolvedSizeBytes must be >= ${MIN_MAX_RESOLVED_SIZE_BYTES}`,
    )
    .default(DEFAULT_MAX_RESOLVED_SIZE_BYTES),
  larkBin: z.string().min(1).optional(),
});

export type ConfigInput = z.input<typeof ConfigSchema>;
export type ConfigParsed = z.output<typeof ConfigSchema>;

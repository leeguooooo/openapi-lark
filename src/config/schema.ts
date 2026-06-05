import { z } from 'zod';
import {
  DEFAULT_PUSH_TIMEOUT_MS,
  DEFAULT_MAX_RESOLVED_SIZE_BYTES,
  MIN_MAX_RESOLVED_SIZE_BYTES,
  MIN_PUSH_TIMEOUT_MS,
  DEFAULT_MAX_PUSH_BYTES,
  MIN_MAX_PUSH_BYTES,
} from '../types.js';

export const RenderSchema = z.object({
  engine: z.enum(['widdershins', 'native']).default('widdershins'),
});

export const ServiceSchema = z.object({
  name: z.string().min(1, 'service.name is required'),
  /**
   * Local file path OR http(s):// URL. URLs cover runtime-generated OpenAPI
   * (chanfana / Hono / FastAPI / NestJS Swagger) — no more stale curl snapshots.
   * When URL → also see `openapiHeaders` (for auth) and `openapiSnapshot` (for git diff).
   */
  openapi: z.string().min(1, 'service.openapi is required'),
  /**
   * Headers sent when `openapi` is a URL. `${ENV_VAR}` interpolation runs in
   * the config loader so secrets stay out of the file:
   *   openapiHeaders:
   *     Authorization: "Bearer ${OPENAPI_TOKEN}"
   * Ignored when `openapi` is a local path.
   */
  openapiHeaders: z.record(z.string()).optional(),
  /**
   * When `openapi` is a URL, write the raw fetched JSON to this path each sync.
   * Lets you commit the snapshot to git for PR diff review. Ignored for local paths.
   */
  openapiSnapshot: z.string().min(1).optional(),
  docToken: z.string().min(1).optional(),
  mode: z.enum(['single', 'tree', 'endpoint']).default('single'),
  tagAliases: z.record(z.string()).optional(),
  includeTags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
  parentTitle: z.string().min(1).optional(),
  /**
   * Auto-prune of zombie wiki nodes (endpoint mode only). Opt-in; default 'off'
   * keeps the historical behaviour (detect + warn, never touch nodes).
   *   - 'off'    — only warn (default).
   *   - 'move'   — relocate each zombie to `pruneSpaceId` via `wiki +move`
   *                (reversible). Requires the `wiki:node:move` scope.
   *   - 'delete' — irreversibly delete each zombie via `wiki +node-delete --yes`.
   *                Requires the wiki node delete scope. Use with care.
   * Only nodes already flagged by zombie detection are ever touched.
   */
  prune: z
    .preprocess(
      // YAML parses bare `off`/`no`/`false` as boolean false (and `on`/`yes`/
      // `true` as true). Normalize those back to our string enum so users can
      // write the natural `prune: off`.
      (v) => {
        if (v === false || v === undefined || v === null) return 'off';
        if (v === true) return 'on'; // invalid on purpose → clear enum error
        return v;
      },
      z.enum(['off', 'move', 'delete']),
    )
    .default('off'),
  /** Target wiki space ID for `prune: move` — zombies are relocated here (a
   *  "recycle bin" space). Required when prune is 'move'; ignored otherwise. */
  pruneSpaceId: z.string().min(1).optional(),
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
  maxPushBytes: z
    .number()
    .int()
    .min(MIN_MAX_PUSH_BYTES, `maxPushBytes must be >= ${MIN_MAX_PUSH_BYTES}`)
    .default(DEFAULT_MAX_PUSH_BYTES),
  parentDocToken: z.string().min(1).optional(),
}).refine(
  (cfg) => {
    // Every service must either have its own docToken OR rely on parentDocToken
    if (cfg.parentDocToken) return true;
    return cfg.services.every((s) => typeof s.docToken === 'string' && s.docToken.length > 0);
  },
  {
    message:
      'Each service needs a docToken OR you must set top-level parentDocToken to auto-create per-service children.',
  },
);

export type ConfigInput = z.input<typeof ConfigSchema>;
export type ConfigParsed = z.output<typeof ConfigSchema>;

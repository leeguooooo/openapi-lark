import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ConfigSchema, type ConfigParsed } from './schema.js';
import { EXIT_CONFIG } from '../types.js';

export class ConfigError extends Error {
  exitCode = EXIT_CONFIG;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CONFIG_FILENAME = '.openapi-lark.yaml';

/**
 * Find .openapi-lark.yaml by walking from cwd up to root.
 */
export function findConfigPath(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve('/');
  while (true) {
    const candidate = resolve(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readYamlObject(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`failed to read config ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`failed to parse yaml ${path}: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new ConfigError(`config ${path} is empty`);
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`config ${path} must be a yaml object at top level`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Deep-ish merge:
 *  - scalars/arrays from child override parent entirely (except `services`)
 *  - `services` are merged by `name` (child overrides parent same-name entry, appends new)
 *  - nested objects (e.g. `engines`) are shallow-merged
 */
function mergeConfig(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parent };
  for (const [k, v] of Object.entries(child)) {
    if (k === 'extends') continue;
    if (k === 'services') {
      const childArr = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
      const parentArr = Array.isArray(parent.services)
        ? (parent.services as Record<string, unknown>[])
        : [];
      const byName = new Map<string, Record<string, unknown>>();
      for (const p of parentArr) byName.set(String(p.name), p);
      for (const c of childArr) byName.set(String(c.name), c);
      out.services = [...byName.values()];
      continue;
    }
    if (
      k === 'engines' &&
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof parent.engines === 'object' &&
      parent.engines !== null &&
      !Array.isArray(parent.engines)
    ) {
      out.engines = {
        ...(parent.engines as Record<string, unknown>),
        ...(v as Record<string, unknown>),
      };
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Walk the object tree and replace `${ENV_NAME}` occurrences in string leaves.
 * Returns the list of env var names that were referenced but not defined.
 */
function interpolateEnv(
  node: unknown,
  env: NodeJS.ProcessEnv,
  missing: Set<string>,
): unknown {
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
      const v = env[name];
      if (v === undefined) {
        missing.add(name);
        return _match;
      }
      return v;
    });
  }
  if (Array.isArray(node)) {
    return node.map((item) => interpolateEnv(item, env, missing));
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = interpolateEnv(v, env, missing);
    }
    return out;
  }
  return node;
}

export interface LoadOptions {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  /** internal flag — set true when loading parent via extends to prevent recursion */
  _isParent?: boolean;
}

export interface LoadResult {
  config: ConfigParsed;
  configPath: string;
  basedir: string;
}

/**
 * Load config:
 *   1. parse yaml
 *   2. resolve `extends` (single layer; deeper layers reject)
 *   3. env interpolate (after extends merge — child can override parent's env refs)
 *   4. zod validate
 */
export function loadConfig(opts: LoadOptions): LoadResult {
  const env = opts.env ?? process.env;
  const childObj = readYamlObject(opts.configPath);
  let merged: Record<string, unknown> = childObj;

  if (typeof childObj.extends === 'string' && childObj.extends.trim() !== '') {
    if (opts._isParent) {
      throw new ConfigError(
        `extends chain exceeds 1 level at ${opts.configPath}; nested extends is not allowed (防滥用)`,
      );
    }
    const parentRel = childObj.extends;
    const parentPath = isAbsolute(parentRel)
      ? parentRel
      : resolve(dirname(opts.configPath), parentRel);
    if (!existsSync(parentPath)) {
      throw new ConfigError(`extends target not found: ${parentPath}`);
    }
    const parentObj = readYamlObject(parentPath);
    if (
      typeof parentObj.extends === 'string' &&
      parentObj.extends.trim() !== ''
    ) {
      throw new ConfigError(
        `extends chain exceeds 1 level at ${parentPath}; nested extends is not allowed (防滥用)`,
      );
    }
    merged = mergeConfig(parentObj, childObj);
  }

  // env interpolate AFTER extends merge — child overrides parent's env refs
  const missing = new Set<string>();
  const interpolated = interpolateEnv(merged, env, missing);
  if (missing.size > 0) {
    const list = [...missing].sort().join(', ');
    throw new ConfigError(
      `undefined environment variables referenced in config: ${list}\n` +
        `export them or override the referencing field in a child config`,
    );
  }

  let parsed: ConfigParsed;
  try {
    parsed = ConfigSchema.parse(interpolated);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.errors.map(
        (e) => `  - ${e.path.length ? e.path.join('.') : '(root)'}: ${e.message}`,
      );
      throw new ConfigError(
        `config validation failed:\n${lines.join('\n')}`,
      );
    }
    throw err;
  }

  // service names must be unique (zod doesn't check this by default)
  const names = parsed.services.map((s) => s.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) {
    throw new ConfigError(`duplicate service name: ${dup}`);
  }

  return {
    config: parsed,
    configPath: opts.configPath,
    basedir: dirname(opts.configPath),
  };
}

/**
 * True when the openapi source is an http(s) URL (vs. local path).
 */
export function isOpenapiUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Resolve a service's openapi path relative to the config basedir.
 * Returns URLs unchanged so callers can pass them through to fetch.
 */
export function resolveOpenapiPath(basedir: string, openapi: string): string {
  if (isOpenapiUrl(openapi)) return openapi;
  return isAbsolute(openapi) ? openapi : resolve(basedir, openapi);
}

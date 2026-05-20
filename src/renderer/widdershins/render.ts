// @ts-expect-error - widdershins has no types
import * as widdershins from 'widdershins';
import { postProcess } from '../post-process.js';
import { detectHeadingJumps, type HeadingWarning } from '../heading-check.js';

export interface RenderInput {
  /** Dereferenced OpenAPI object */
  api: unknown;
}

export interface RenderOutput {
  markdown: string;
  headingWarnings: HeadingWarning[];
}

/**
 * Widdershins options tuned for 飞书 docx:
 *  - language_tabs: only curl (KNOWN_ISSUE #4: multi-lang tabs render as raw blocks)
 *  - omitHeader: we write our own service-prefixed header
 *  - codeSamples: keep curl example only
 *  - search: false
 *  - tocSummary: false (flat)
 *  - resolve: false — we dereference upstream via swagger-parser
 *  - httpsnippet: false (avoid dependency surprises)
 */
const WIDDERSHINS_OPTIONS = {
  language_tabs: [{ curl: 'curl' }],
  omitHeader: false,
  codeSamples: true,
  resolve: false,
  search: false,
  tocSummary: false,
  shallowSchemas: false,
  expandBody: true,
  httpsnippet: false,
  user_templates: undefined,
};

export async function renderWiddershins(input: RenderInput): Promise<RenderOutput> {
  // widdershins exports `convert(api, options, callback)` and a promise variant
  // depending on version; wrap both.
  const convert = (widdershins as any).convert as (
    api: unknown,
    options: unknown,
    cb?: (err: Error | null, out: string) => void,
  ) => Promise<string> | void;

  const raw = await new Promise<string>((resolve, reject) => {
    try {
      const maybe = convert(input.api, WIDDERSHINS_OPTIONS, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
      // promise variant
      if (maybe && typeof (maybe as Promise<string>).then === 'function') {
        (maybe as Promise<string>).then(resolve, reject);
      }
    } catch (err) {
      reject(err as Error);
    }
  });

  const md = postProcess(raw);
  const headingWarnings = detectHeadingJumps(md);
  return { markdown: md, headingWarnings };
}

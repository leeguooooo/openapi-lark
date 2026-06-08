// @ts-expect-error - widdershins has no types
import * as widdershins from 'widdershins';
import { createRequire } from 'node:module';
import { postProcess } from '../post-process.js';
import { detectHeadingJumps, type HeadingWarning } from '../heading-check.js';
import { exampleForOperation } from '../example-from-schema.js';
import { injectSecuritySection } from '../security-section.js';
import { injectRequestExample } from '../request-example.js';

// Silence the doT template engine's compile-time chatter (widdershins emits
// 24+ lines of "Loaded def authentication.def" / "Compiling code_csharp.dot"
// per render). dot.log defaults to true; setting once is enough (singleton).
// Override with OPENAPI_LARK_VERBOSE=1 if you actually want to see them.
// Use createRequire so we get the mutable CJS module object (ESM namespace
// imports are frozen — assigning .log throws "Cannot assign to property 'log'").
if (!process.env.OPENAPI_LARK_VERBOSE) {
  try {
    const cjsRequire = createRequire(import.meta.url);
    const dotMod = cjsRequire('dot');
    dotMod.log = false;
  } catch {
    // dot not present or unwritable — ignore; noise stays but doesn't break us
  }
}

export interface RenderInput {
  /** Dereferenced OpenAPI object */
  api: unknown;
  /** When set, enables the "redundant operation intro" collapse — only safe
   *  when the api contains exactly one operation (endpoint-mode leaf). */
  singleOperationSummary?: string;
}

export interface RenderOutput {
  markdown: string;
  headingWarnings: HeadingWarning[];
}

/**
 * Widdershins options tuned for 飞书 docx & endpoint-mode legibility:
 *  - language_tabs: only curl (KNOWN_ISSUE #4: multi-lang tabs render as raw blocks)
 *  - omitHeader: we write our own service-prefixed header
 *  - codeSamples: false (saves ~30-40% of output; users see schemas, not duplicated examples)
 *  - search: false
 *  - tocSummary: false (flat)
 *  - resolve: false — we dereference upstream via swagger-parser
 *  - httpsnippet: false (avoid dependency surprises)
 *  - shallowSchemas: false — must show response Schema fields (a/k/a "Status 200
 *    showed Inline but the actual field table never rendered" — observed
 *    2026-05-20). With endpoint-split, doc bloat from full schema expansion
 *    is bounded to a single operation, no longer a size problem.
 *  - expandBody: true — same reason; request body should display its schema table.
 */
const WIDDERSHINS_OPTIONS = {
  language_tabs: [{ curl: 'curl' }],
  omitHeader: false,
  codeSamples: false,
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

  let md = postProcess(raw, input.api, input.singleOperationSummary);
  // For single-operation slices (endpoint mode):
  //  1. inject a 鉴权 section (operation's effective security in plain 中文)
  //  2. append a synthesized 请求示例 (curl) + 响应示例 (JSON). Widdershins' own
  //     example dump is broken for allOf schemas (stripped in post-process);
  //     these replacements use op schemas after allOf-flatten.
  if (input.singleOperationSummary) {
    md = injectSecuritySection(md, input.api);
    md = appendResponseExample(md, input.api);
    md = injectRequestExample(md, input.api);
  }
  const headingWarnings = detectHeadingJumps(md);
  return { markdown: md, headingWarnings };
}

function appendResponseExample(md: string, api: any): string {
  const paths = api?.paths;
  if (!paths || typeof paths !== 'object') return md;
  // Single-op slice: exactly one (path, method) under api.paths
  for (const pathItem of Object.values(paths as Record<string, any>)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const op of Object.values(pathItem as Record<string, any>)) {
      if (!op || typeof op !== 'object') continue;
      if (!('responses' in op)) continue;
      const ex = exampleForOperation(op);
      if (!ex) return md;
      const json = JSON.stringify(ex.example, null, 2);
      const block =
        `\n\n### 响应示例 (${ex.status})\n\n` +
        '```json\n' +
        json +
        '\n```\n';
      return md.trimEnd() + block;
    }
  }
  return md;
}

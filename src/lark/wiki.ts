import { spawnSync } from 'node:child_process';

export interface WikiNodeInfo {
  spaceId: string;
  nodeToken: string;
  objToken: string;
  objType: string;
  title: string;
  parentNodeToken: string;
}

export interface WikiChild {
  nodeToken: string;
  objToken: string;
  title: string;
  objType: string;
  hasChild: boolean;
}

export class WikiError extends Error {
  exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = 'WikiError';
  }
}

function looksLikeLockContention(body: string): boolean {
  return (
    body.includes('131009') ||
    body.toLowerCase().includes('lock contention')
  );
}

function sleepSync(ms: number): void {
  // Synchronous sleep for retry backoff. Avoids requiring caller to be async.
  const until = Date.now() + ms;
  // eslint-disable-next-line no-empty
  const spawnSync = require('node:child_process').spawnSync;
  // Use shell sleep for accurate ms-level wait without busy-loop
  spawnSync('sleep', [(ms / 1000).toFixed(3)], { stdio: 'ignore', timeout: ms + 5000 });
  // Guard in case sleep is unavailable (Windows): fall back to small busy-wait spike
  if (Date.now() < until) {
    while (Date.now() < until) {
      /* busy wait short tail */
    }
  }
}

function runLark(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs = 30_000,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    env: env ?? process.env,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new WikiError(`lark-cli binary "${bin}" not found in PATH`);
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    status: res.status,
  };
}

/**
 * Resolve a wiki node (by token) to its space ID + underlying docx obj_token.
 * Uses `lark-cli wiki spaces get_node --params '{"token":"..."}'`.
 */
export function resolveWikiNode(
  nodeToken: string,
  larkBin = 'lark-cli',
  env?: NodeJS.ProcessEnv,
): WikiNodeInfo {
  const params = JSON.stringify({ token: nodeToken });
  const r = runLark(larkBin, ['wiki', 'spaces', 'get_node', '--params', params], env);
  if (!r.ok) {
    throw new WikiError(`wiki spaces get_node failed: ${r.stderr || r.stdout}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new WikiError(`wiki spaces get_node returned non-JSON: ${(err as Error).message}`);
  }
  const node = parsed?.data?.node;
  if (!node) throw new WikiError(`wiki spaces get_node: missing data.node in response`);
  return {
    spaceId: node.space_id ?? node.origin_space_id,
    nodeToken: node.node_token,
    objToken: node.obj_token,
    objType: node.obj_type,
    title: node.title,
    parentNodeToken: node.parent_node_token ?? '',
  };
}

/**
 * List immediate children of a wiki node.
 * Uses `lark-cli wiki +node-list --space-id X --parent-node-token Y --page-all`.
 */
export function listWikiChildren(
  spaceId: string,
  parentNodeToken: string,
  larkBin = 'lark-cli',
  env?: NodeJS.ProcessEnv,
): WikiChild[] {
  const r = runLark(
    larkBin,
    [
      'wiki',
      '+node-list',
      '--space-id',
      spaceId,
      '--parent-node-token',
      parentNodeToken,
      '--page-all',
      '--page-size',
      '50',
    ],
    env,
  );
  if (!r.ok) {
    throw new WikiError(`wiki +node-list failed: ${r.stderr || r.stdout}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new WikiError(`wiki +node-list returned non-JSON: ${(err as Error).message}`);
  }
  // Real shape (lark-cli 1.0.32): { data: { nodes: [...], has_more: bool } }
  // Fall through other plausible shapes for forward compat.
  const items: any[] =
    parsed?.data?.nodes ??
    parsed?.data?.items ??
    parsed?.nodes ??
    parsed?.items ??
    (Array.isArray(parsed?.data) ? parsed.data : null) ??
    (Array.isArray(parsed) ? parsed : []);
  return (Array.isArray(items) ? items : []).map((n) => ({
    nodeToken: n.node_token,
    objToken: n.obj_token,
    title: n.title,
    objType: n.obj_type,
    hasChild: !!n.has_child,
  }));
}

/**
 * Create a child wiki node under a parent. Returns the new node's tokens.
 * Uses `lark-cli wiki +node-create --space-id X --parent-node-token Y --title T --obj-type docx`.
 */
export function createWikiChild(
  spaceId: string,
  parentNodeToken: string,
  title: string,
  larkBin = 'lark-cli',
  env?: NodeJS.ProcessEnv,
): WikiChild {
  // Lark wiki has server-side lock contention when creating many children under
  // the same parent in quick succession (error 131009). Auto-retry a few times
  // with exponential backoff.
  const args = [
    'wiki',
    '+node-create',
    '--space-id',
    spaceId,
    '--parent-node-token',
    parentNodeToken,
    '--title',
    title,
    '--obj-type',
    'docx',
    '--node-type',
    'origin',
  ];
  const MAX_RETRIES = 4;
  let r;
  let lastBody = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    r = runLark(larkBin, args, env, 60_000);
    lastBody = r.stdout || r.stderr;
    if (r.ok && !looksLikeLockContention(lastBody)) break;
    // Inspect JSON body to detect server-side errors that succeeded at CLI level
    if (r.ok) {
      try {
        const j = JSON.parse(r.stdout);
        if (j && j.ok !== false) break; // genuine success
      } catch {
        break;
      }
    }
    if (!looksLikeLockContention(lastBody) || attempt === MAX_RETRIES) break;
    const delayMs = 250 * Math.pow(2, attempt); // 250 / 500 / 1000 / 2000 / 4000
    sleepSync(delayMs);
  }
  if (!r!.ok || looksLikeLockContention(lastBody)) {
    throw new WikiError(
      `wiki +node-create "${title}" failed after retries: ${lastBody.slice(0, 300)}`,
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(r!.stdout);
  } catch (err) {
    throw new WikiError(`wiki +node-create returned non-JSON: ${(err as Error).message}`);
  }
  // Real shape (lark-cli 1.0.32): { data: { node_token, obj_token, ... } } — flat under data
  const node = parsed?.data?.node ?? parsed?.data ?? parsed?.node ?? parsed;
  if (!node?.node_token || !node?.obj_token) {
    throw new WikiError(`wiki +node-create response missing tokens: ${r!.stdout.slice(0, 200)}`);
  }
  return {
    nodeToken: node.node_token,
    objToken: node.obj_token,
    title: node.title ?? title,
    objType: node.obj_type ?? 'docx',
    hasChild: false,
  };
}

/**
 * Move a wiki node to another wiki space (the "recycle bin" space). This is the
 * SAFE prune path for wiki-hosted docx: `drive +delete` returns forbidden on
 * them, but `wiki +move` relocates the node out of the project tree.
 *
 * Uses `lark-cli wiki +move --node-token X --target-space-id Y [--source-space-id Z]`.
 * Requires the `wiki:node:move` scope. Throws WikiError on failure so the caller
 * can record a per-node failure without aborting the whole sync.
 */
export function moveWikiNode(
  nodeToken: string,
  targetSpaceId: string,
  sourceSpaceId: string | undefined,
  larkBin = 'lark-cli',
  env?: NodeJS.ProcessEnv,
): void {
  const args = ['wiki', '+move', '--node-token', nodeToken, '--target-space-id', targetSpaceId];
  if (sourceSpaceId) args.push('--source-space-id', sourceSpaceId);
  const r = runLark(larkBin, args, env, 60_000);
  if (!r.ok) {
    throw new WikiError(`wiki +move ${nodeToken} → ${targetSpaceId} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
}

/**
 * Delete a wiki node (irreversible). Used by `prune: delete`. `--yes` confirms the
 * high-risk operation.
 *
 * `--obj-type` is the *token kind*, not the node's underlying object type. We always
 * pass a wiki node_token here, so it is hardcoded to `wiki`. Passing the node's
 * obj_type (docx/sheet/…) makes lark-cli treat the node_token as that object's token
 * and fail with 131005 (document not found).
 *
 * Uses `lark-cli wiki +node-delete --node-token X --obj-type wiki --space-id S --yes`.
 * Requires the wiki node delete scope. Throws WikiError on failure.
 */
export function deleteWikiNode(
  nodeToken: string,
  spaceId: string | undefined,
  larkBin = 'lark-cli',
  env?: NodeJS.ProcessEnv,
): void {
  const args = ['wiki', '+node-delete', '--node-token', nodeToken, '--obj-type', 'wiki', '--yes'];
  if (spaceId) args.push('--space-id', spaceId);
  const r = runLark(larkBin, args, env, 60_000);
  if (!r.ok) {
    throw new WikiError(`wiki +node-delete ${nodeToken} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
}

/**
 * Find an existing child by title (case-insensitive) or create it.
 */
export function findOrCreateChild(
  spaceId: string,
  parentNodeToken: string,
  title: string,
  larkBin: string,
  env?: NodeJS.ProcessEnv,
): { child: WikiChild; created: boolean } {
  const children = listWikiChildren(spaceId, parentNodeToken, larkBin, env);
  const want = title.trim().toLowerCase();
  const existing = children.find((c) => c.title.trim().toLowerCase() === want);
  if (existing) return { child: existing, created: false };
  return { child: createWikiChild(spaceId, parentNodeToken, title, larkBin, env), created: true };
}

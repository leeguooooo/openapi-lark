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
  // lark-cli's +node-list returns various shapes; normalize.
  const items: any[] =
    parsed?.data?.items ??
    parsed?.items ??
    parsed?.data ??
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
  const r = runLark(
    larkBin,
    [
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
    ],
    env,
    60_000,
  );
  if (!r.ok) {
    throw new WikiError(`wiki +node-create "${title}" failed: ${r.stderr || r.stdout}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new WikiError(`wiki +node-create returned non-JSON: ${(err as Error).message}`);
  }
  const node = parsed?.data?.node ?? parsed?.node ?? parsed;
  if (!node?.node_token || !node?.obj_token) {
    throw new WikiError(`wiki +node-create response missing tokens: ${r.stdout.slice(0, 200)}`);
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

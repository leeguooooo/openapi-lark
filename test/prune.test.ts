import { describe, it, expect, vi } from 'vitest';
import { pruneZombies, type ZombieNode, type PruneDeps } from '../src/commands/sync-endpoint.js';
import {
  loadNodeMap,
  setTagNode,
  setLeafNode,
  getTagNode,
  getLeafNode,
  endpointIdentity,
  type NodeMapData,
} from '../src/node-map.js';
import { type SyncLockData, LOCK_VERSION } from '../src/sync-lock.js';

const SVC = 'demo-api';

function makeZombie(over: Partial<ZombieNode> = {}): ZombieNode {
  return {
    kind: 'leaf',
    title: 'POST /api/v1/old',
    nodeToken: 'nodeZOMBIE1',
    objToken: 'objZOMBIE1',
    objType: 'docx',
    spaceId: 'space-src',
    parentTitle: 'tag',
    endpointIdentity: 'POST /api/v1/old',
    ...over,
  };
}

function emptyNodeMap(): NodeMapData {
  return { version: 1, services: {} };
}
function emptyLock(): SyncLockData {
  return { version: LOCK_VERSION, services: {} };
}

function mockDeps(): PruneDeps & { move: any; remove: any } {
  return {
    move: vi.fn(),
    remove: vi.fn(),
  };
}

describe('pruneZombies: prune off / no zombies', () => {
  it('does nothing when prune is off', () => {
    const deps = mockDeps();
    const res = pruneZombies([makeZombie()], baseOpts({ prune: 'off' }), deps);
    expect(deps.move).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
    expect(res).toEqual({ pruned: 0, failed: 0 });
  });

  it('does nothing when prune is undefined', () => {
    const deps = mockDeps();
    pruneZombies([makeZombie()], baseOpts({ prune: undefined }), deps);
    expect(deps.move).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('does nothing when zombie list is empty', () => {
    const deps = mockDeps();
    const res = pruneZombies([], baseOpts({ prune: 'move', pruneSpaceId: 'recycle' }), deps);
    expect(deps.move).not.toHaveBeenCalled();
    expect(res).toEqual({ pruned: 0, failed: 0 });
  });
});

describe('pruneZombies: move', () => {
  it('errors and skips when pruneSpaceId is missing', () => {
    const deps = mockDeps();
    const res = pruneZombies([makeZombie()], baseOpts({ prune: 'move' }), deps);
    expect(deps.move).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
    expect(res).toEqual({ pruned: 0, failed: 0 });
  });

  it('calls move once per zombie with the right args', () => {
    const deps = mockDeps();
    const z1 = makeZombie({ nodeToken: 'n1', objToken: 'o1', spaceId: 'src1' });
    const z2 = makeZombie({ nodeToken: 'n2', objToken: 'o2', spaceId: 'src2', kind: 'tag' });
    const res = pruneZombies(
      [z1, z2],
      baseOpts({ prune: 'move', pruneSpaceId: 'recycle-space' }),
      deps,
    );
    expect(deps.move).toHaveBeenCalledTimes(2);
    expect(deps.move).toHaveBeenNthCalledWith(1, 'n1', 'recycle-space', 'src1', 'lark-cli');
    expect(deps.move).toHaveBeenNthCalledWith(2, 'n2', 'recycle-space', 'src2', 'lark-cli');
    expect(deps.remove).not.toHaveBeenCalled();
    expect(res).toEqual({ pruned: 2, failed: 0 });
  });

  it('removes node-map + lock entries after a successful move', () => {
    const deps = mockDeps();
    const nodeMap = emptyNodeMap();
    setTagNode(nodeMap, SVC, 'oldtag', 'n1');
    setLeafNode(nodeMap, SVC, endpointIdentity('POST', '/api/v1/old'), 'n1');
    const lock = emptyLock();
    lock.services[SVC] = { o1: { sha256: 'abc', syncedAt: 'now' } };

    pruneZombies(
      [makeZombie({ nodeToken: 'n1', objToken: 'o1' })],
      baseOpts({ prune: 'move', pruneSpaceId: 'recycle-space', nodeMap, lock }),
      deps,
    );

    expect(getTagNode(nodeMap, SVC, 'oldtag')).toBeUndefined();
    expect(getLeafNode(nodeMap, SVC, endpointIdentity('POST', '/api/v1/old'))).toBeUndefined();
    expect(lock.services[SVC].o1).toBeUndefined();
  });
});

describe('pruneZombies: delete', () => {
  it('calls node-delete with obj-type per zombie', () => {
    const deps = mockDeps();
    const z = makeZombie({ nodeToken: 'n9', objType: 'docx', spaceId: 'src9' });
    const res = pruneZombies([z], baseOpts({ prune: 'delete' }), deps);
    expect(deps.remove).toHaveBeenCalledTimes(1);
    expect(deps.remove).toHaveBeenCalledWith('n9', 'docx', 'src9', 'lark-cli');
    expect(deps.move).not.toHaveBeenCalled();
    expect(res).toEqual({ pruned: 1, failed: 0 });
  });

  it('defaults obj-type to docx when missing', () => {
    const deps = mockDeps();
    const z = makeZombie({ objType: undefined });
    pruneZombies([z], baseOpts({ prune: 'delete' }), deps);
    expect(deps.remove).toHaveBeenCalledWith(expect.any(String), 'docx', expect.any(String), 'lark-cli');
  });
});

describe('pruneZombies: dry-run', () => {
  it('does not call move/delete and keeps node-map intact', () => {
    const deps = mockDeps();
    const nodeMap = emptyNodeMap();
    setTagNode(nodeMap, SVC, 'oldtag', 'n1');
    pruneZombies(
      [makeZombie({ nodeToken: 'n1' })],
      baseOpts({ prune: 'move', pruneSpaceId: 'recycle', dryRun: true, nodeMap }),
      deps,
    );
    expect(deps.move).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
    expect(getTagNode(nodeMap, SVC, 'oldtag')).toBe('n1'); // untouched
  });
});

describe('pruneZombies: resilience', () => {
  it('skips dry-run-faked nodes (dryrun- token) even in real mode', () => {
    const deps = mockDeps();
    const res = pruneZombies(
      [makeZombie({ nodeToken: 'dryrun-node-foo' })],
      baseOpts({ prune: 'delete' }),
      deps,
    );
    expect(deps.remove).not.toHaveBeenCalled();
    expect(res).toEqual({ pruned: 0, failed: 0 });
  });

  it('counts a per-node failure without throwing, continues other nodes', () => {
    const deps = mockDeps();
    deps.move
      .mockImplementationOnce(() => {
        throw new Error('forbidden');
      })
      .mockImplementationOnce(() => {});
    const nodeMap = emptyNodeMap();
    setTagNode(nodeMap, SVC, 'tagA', 'nFAIL');
    setTagNode(nodeMap, SVC, 'tagB', 'nOK');
    const res = pruneZombies(
      [makeZombie({ nodeToken: 'nFAIL' }), makeZombie({ nodeToken: 'nOK' })],
      baseOpts({ prune: 'move', pruneSpaceId: 'recycle', nodeMap }),
      deps,
    );
    expect(res).toEqual({ pruned: 1, failed: 1 });
    // failed node's map entry is NOT removed; successful one is.
    expect(getTagNode(nodeMap, SVC, 'tagA')).toBe('nFAIL');
    expect(getTagNode(nodeMap, SVC, 'tagB')).toBeUndefined();
  });
});

// --- helper -------------------------------------------------------------

function baseOpts(over: {
  prune?: 'off' | 'move' | 'delete';
  pruneSpaceId?: string;
  dryRun?: boolean;
  nodeMap?: NodeMapData;
  lock?: SyncLockData;
}) {
  return {
    svcName: SVC,
    prune: over.prune,
    pruneSpaceId: over.pruneSpaceId,
    larkBin: 'lark-cli',
    dryRun: over.dryRun ?? false,
    nodeMap: over.nodeMap ?? emptyNodeMap(),
    lock: over.lock ?? emptyLock(),
  };
}

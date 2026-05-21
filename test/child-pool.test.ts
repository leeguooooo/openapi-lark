import { describe, it, expect } from 'vitest';
import {
  buildChildPool,
  popByNodeToken,
  popByEndpointIdentity,
  popByTitle,
  popByCascade,
  remainingChildren,
} from '../src/lark/child-pool.js';
import type { WikiChild } from '../src/lark/wiki.js';

function child(nodeToken: string, title: string): WikiChild {
  return {
    nodeToken,
    objToken: `doc-${nodeToken}`,
    title,
    objType: 'docx',
    hasChild: false,
  };
}

describe('child-pool: buildChildPool', () => {
  it('indexes children by all three keys', () => {
    const pool = buildChildPool([
      child('N1', '预测 — POST /api/v1/predicts'),
      child('N2', 'games'),
    ]);
    expect(pool.byNodeToken.get('N1')?.title).toBe('预测 — POST /api/v1/predicts');
    expect(pool.byEndpointIdentity.get('POST /api/v1/predicts')?.nodeToken).toBe('N1');
    expect(pool.byTitle.get('games')?.[0]?.nodeToken).toBe('N2');
    // intermediate "games" has no METHOD path → no identity entry
    expect(pool.byEndpointIdentity.size).toBe(1);
  });

  it('first match wins when two children share an endpoint identity', () => {
    const pool = buildChildPool([
      child('N1', '预测 — POST /api/v1/predicts'),
      child('N2', '创建预测（下注） — POST /api/v1/predicts'), // duplicate identity
    ]);
    expect(pool.byEndpointIdentity.get('POST /api/v1/predicts')?.nodeToken).toBe('N1');
    // The duplicate is still discoverable via byNodeToken
    expect(pool.byNodeToken.get('N2')).toBeDefined();
  });
});

describe('child-pool: pop variants stay consistent', () => {
  it('popByNodeToken removes from byTitle and byEndpointIdentity too', () => {
    const pool = buildChildPool([
      child('N1', '预测 — POST /api/v1/predicts'),
      child('N2', 'games'),
    ]);
    const popped = popByNodeToken(pool, 'N1');
    expect(popped?.nodeToken).toBe('N1');
    expect(pool.byNodeToken.has('N1')).toBe(false);
    expect(pool.byEndpointIdentity.has('POST /api/v1/predicts')).toBe(false);
    expect(pool.byTitle.has('预测 — post /api/v1/predicts')).toBe(false);
  });

  it('popByEndpointIdentity matches across summary change', () => {
    // Existing wiki node title uses old summary; new request lookup uses new identity.
    const pool = buildChildPool([
      child('N1', '预测 — POST /api/v1/predicts'),
    ]);
    const popped = popByEndpointIdentity(pool, 'POST /api/v1/predicts');
    expect(popped?.nodeToken).toBe('N1');
    expect(remainingChildren(pool)).toHaveLength(0);
  });

  it('popByTitle still supports zombie recovery (Authentication)', () => {
    const pool = buildChildPool([child('N1', 'Authentication')]);
    const popped = popByTitle(pool, 'games');
    expect(popped?.nodeToken).toBe('N1');
  });

  it('popByTitle still supports inverse "X — Y" / "Y — X" swap', () => {
    const pool = buildChildPool([child('N1', 'POST /api/v1/predicts — 预测')]);
    const popped = popByTitle(pool, '预测 — POST /api/v1/predicts');
    expect(popped?.nodeToken).toBe('N1');
  });

  it('returns undefined on miss', () => {
    const pool = buildChildPool([child('N1', 'foo')]);
    expect(popByNodeToken(pool, 'XYZ')).toBeUndefined();
    expect(popByEndpointIdentity(pool, 'GET /missing')).toBeUndefined();
    expect(popByTitle(pool, 'something')).toBeUndefined();
  });
});

describe('child-pool: popByCascade', () => {
  it('prefers nodeToken over identity over title', () => {
    const pool = buildChildPool([
      child('N1', '预测 — POST /api/v1/predicts'),
      child('N2', '创建预测（下注） — POST /api/v1/predicts'),
    ]);
    // Asking for N2 by token should win even though N1 holds the identity.
    const popped = popByCascade(pool, {
      nodeToken: 'N2',
      endpointIdentity: 'POST /api/v1/predicts',
      title: '预测 — POST /api/v1/predicts',
    });
    expect(popped?.nodeToken).toBe('N2');
    // N1 still in pool
    expect(pool.byNodeToken.has('N1')).toBe(true);
  });

  it('falls back to identity when nodeToken miss', () => {
    const pool = buildChildPool([child('N1', '预测 — POST /api/v1/predicts')]);
    const popped = popByCascade(pool, {
      nodeToken: 'STALE_TOKEN',
      endpointIdentity: 'POST /api/v1/predicts',
      title: '创建预测（下注） — POST /api/v1/predicts',
    });
    expect(popped?.nodeToken).toBe('N1');
  });

  it('falls back to title when both nodeToken and identity miss', () => {
    const pool = buildChildPool([child('N1', 'games')]);
    const popped = popByCascade(pool, {
      nodeToken: 'STALE',
      endpointIdentity: 'GET /none',
      title: 'games',
    });
    expect(popped?.nodeToken).toBe('N1');
  });

  it('returns undefined when all strategies miss', () => {
    const pool = buildChildPool([child('N1', 'unrelated')]);
    expect(
      popByCascade(pool, {
        nodeToken: 'STALE',
        endpointIdentity: 'GET /none',
        title: 'no-such-title',
      }),
    ).toBeUndefined();
  });
});

describe('child-pool: remainingChildren (zombie reporting)', () => {
  it('lists children still unclaimed after pops', () => {
    const pool = buildChildPool([
      child('N1', '预测 — POST /api/v1/predicts'),
      child('N2', 'GET /api/v1/legacy'),
      child('N3', 'games'),
    ]);
    popByEndpointIdentity(pool, 'POST /api/v1/predicts');
    const rest = remainingChildren(pool);
    expect(rest.map((c) => c.nodeToken).sort()).toEqual(['N2', 'N3']);
  });
});

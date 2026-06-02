import { describe, it, expect } from 'vitest';
import { detectMisconfiguredParent } from '../src/lark/parent-guard.js';
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

describe('detectMisconfiguredParent', () => {
  const expectedTags = ['管理端接口', '评论接口', '预测接口'];

  it('returns null for an empty parent (brand-new project)', () => {
    const r = detectMisconfiguredParent({ children: [], expectedTagTitles: expectedTags });
    expect(r).toBeNull();
  });

  it('returns null when all children are recognized tags', () => {
    const children = [
      child('N1', '管理端接口'),
      child('N2', '评论接口'),
      child('N3', '预测接口'),
    ];
    const r = detectMisconfiguredParent({ children, expectedTagTitles: expectedTags });
    expect(r).toBeNull();
  });

  it('returns null when children are endpoint-leaf-shaped (prior sync under correct parent)', () => {
    const children = [
      child('N1', '创建预测（下注） — POST /api/v1/predicts'),
      child('N2', '预测历史列表 — GET /api/v1/predicts'),
      child('N3', '管理端接口'),
      child('N4', '评论接口'),
      child('N5', '预测接口'),
    ];
    const r = detectMisconfiguredParent({ children, expectedTagTitles: expectedTags });
    expect(r).toBeNull();
  });

  it('tolerates a few stale tag zombies under a correct parent (below threshold)', () => {
    // Real forecast case: current tags recognized + a handful of old-tag zombies.
    const children = [
      child('N1', '管理端接口'),
      child('N2', '评论接口'),
      child('N3', '预测接口'),
      child('N4', '创建预测（下注） — POST /api/v1/predicts'), // leaf-shaped
      child('N5', '竞猜接口'), // stale tag zombie (foreign)
      child('N6', '优惠券接口'), // stale tag zombie (foreign)
    ];
    const r = detectMisconfiguredParent({ children, expectedTagTitles: expectedTags });
    expect(r).toBeNull(); // 2 foreign / 6 = 33% < 80%
  });

  it('flags a parent where almost everything is foreign (shared/root node)', () => {
    const children = [
      child('N1', '产品需求文档'),
      child('N2', '会议纪要 2026-05'),
      child('N3', '团队 OKR'),
      child('N4', '其他项目 API'),
      child('N5', '运维手册'),
      child('N6', '预测接口'), // the only recognized one
    ];
    const r = detectMisconfiguredParent({ children, expectedTagTitles: expectedTags });
    expect(r).not.toBeNull();
    expect(r!.foreignCount).toBe(5);
    expect(r!.totalCount).toBe(6);
    expect(r!.foreignTitles).toContain('产品需求文档');
  });

  it('does not flag when total children below minimum even if all foreign', () => {
    // 4 foreign but small count — could be a legit tiny shared parent; don't cry wolf.
    const children = [
      child('N1', '随便一个文档'),
      child('N2', '另一个文档'),
    ];
    const r = detectMisconfiguredParent({ children, expectedTagTitles: expectedTags });
    expect(r).toBeNull();
  });

  it('case-insensitive + trims when matching expected tag titles', () => {
    const children = [
      child('N1', '  管理端接口  '),
      child('N2', '评论接口'),
      child('N3', '预测接口'),
      child('N4', '管理端接口'),
      child('N5', '评论接口'),
    ];
    const r = detectMisconfiguredParent({ children, expectedTagTitles: expectedTags });
    expect(r).toBeNull();
  });

  it('respects a custom threshold + minChildren', () => {
    const children = [
      child('N1', 'foreign-a'),
      child('N2', 'foreign-b'),
      child('N3', '预测接口'),
    ];
    // default would not flag (total 3 < min 5); lower the bar
    const r = detectMisconfiguredParent({
      children,
      expectedTagTitles: expectedTags,
      minChildren: 3,
      foreignFractionThreshold: 0.6,
    });
    expect(r).not.toBeNull();
    expect(r!.foreignCount).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import { splitOneOfVariants } from '../src/renderer/oneof-variants.js';
import { markdownToXml } from '../src/renderer/markdown-to-xml.js';

// widdershins 对 body: { oneOf: [common, board] } 的原始输出（缩到最小）
const RAW = `Status Code **200**

| 名称 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|
|» data|object|true| | |
|»» chunks|[object]|true| |命中的块|
|»»» key|string|true| |块键|
|»»» body|any|true| |块内容，形状由 key 决定（四选一）|

*oneOf*

| 名称 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|
|»»»» *anonymous*|object|false| |key=common 时：公开参数|
|»»»»» shield_max|integer|true| |盾牌上限|
|»»»»» multipliers|[object]|true| |倍率表|
|»»»»»» multiplier|integer|true| |倍率|

*xor*

| 名称 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|
|»»»» *anonymous*|object|false| |key=board 时：盘面|
|»»»»» cells|[object]|true| |启用的盘面格|
|»»»»»» code|integer|true| |格子编号|

#### 枚举值
| 字段 | 取值 |
|---|---|
|data.chunks[].body.cells[].cat|ECONOMY|
`;

describe('splitOneOfVariants', () => {
  const out = splitOneOfVariants(RAW);

  it('去掉 *oneOf* / *xor* / *anonymous*，换成带完整路径的变体标题', () => {
    expect(out).not.toContain('*oneOf*');
    expect(out).not.toContain('*xor*');
    expect(out).not.toContain('anonymous');
    expect(out).toContain('**data.chunks[].body 形状 1/2：key=common 时：公开参数**');
    expect(out).toContain('**data.chunks[].body 形状 2/2：key=board 时：盘面**');
  });

  it('变体表第一列是从主表续下来的完整点路径，数组段带 []', () => {
    expect(out).toContain('|data.chunks[].body.shield_max|integer|true| |盾牌上限|');
    expect(out).toContain('|data.chunks[].body.multipliers[]|[object]|true| |倍率表|');
    expect(out).toContain('|data.chunks[].body.multipliers[].multiplier|integer|true| |倍率|');
    expect(out).toContain('|data.chunks[].body.cells[].code|integer|true| |格子编号|');
  });

  it('变体全是 object 时，主表那行的类型由 any 改成 object', () => {
    expect(out).toContain('|»»» body|object|true| |块内容，形状由 key 决定（四选一）|');
  });

  it('主表其余行与后面的枚举表原样保留', () => {
    expect(out).toContain('|»»» key|string|true| |块键|');
    expect(out).toContain('|data.chunks[].body.cells[].cat|ECONOMY|');
  });

  it('转飞书 XML 后，主表是点路径、变体表路径不变、标题是粗体', () => {
    const xml = markdownToXml(out, { paths: {} });
    expect(xml).toContain('data.chunks[].body');
    expect(xml).toContain('data.chunks[].body.shield_max');
    expect(xml).toContain('data.chunks[].body.cells[].code');
    expect(xml).not.toContain('»');
    expect(xml).toMatch(/<b>data\.chunks\[\]\.body 形状 1\/2：key=common 时：公开参数<\/b>/);
  });

  it('没有 oneOf 的文档原样返回', () => {
    const md = '| 名称 | 类型 |\n|---|---|\n|» a|string|\n\n正文';
    expect(splitOneOfVariants(md)).toBe(md);
  });

  it('顶层就是 oneOf（没有父字段路径）也能分表', () => {
    const md = `| 名称 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|
|» result|any|true| |二选一|

*oneOf*

| 名称 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|
|»» *anonymous*|object|false| |成功|
|»»» id|string|true| |编号|

*xor*

| 名称 | 类型 | 必填 | 约束 | 描述 |
|---|---|---|---|---|
|»» *anonymous*|string|false| |失败原因|
`;
    const o = splitOneOfVariants(md);
    expect(o).toContain('**result 形状 1/2：成功**');
    expect(o).toContain('|result.id|string|true| |编号|');
    expect(o).toContain('**result 形状 2/2：失败原因**');
    // 变体不全是 object，主表类型不动
    expect(o).toContain('|» result|any|true| |二选一|');
  });
});

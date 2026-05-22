# Changelog

## 0.3.0 — 2026-05-22

### `init` 现在会自动注入 CLAUDE.md 段（AI 可读引导）

`openapi-lark init` 在写 `.openapi-lark.yaml` 时，**同时往项目根 `CLAUDE.md` 注入一段 openapi-lark 管理块**，告诉 AI agent 怎么查项目接口：

- 直接 Read 本地 OpenAPI spec 文件（小项目最快路径）
- 用 `lark-cli drive +search --query "<关键字>"` 搜飞书 wiki 镜像（path / 中文 summary / 单词都能命中）
- 用 `lark-cli docs +fetch --doc <token> --api-version v2` 取单文档全文

特性：
- **幂等**：begin/end marker 之间替换；marker 之外用户内容原封保留
- **opt-out**：`init --no-claude-md` 跳过
- **URL 型 openapi 自动切提示**：从 Read 切到 curl

这是 v0.3 AI-recall 设计被砍后的轻量替代。完整决策记录见 `docs/superpowers/specs/2026-05-22-openapi-lark-ai-recall-design.html`。砍掉理由：实测 `lark-cli drive +search` 精度并不差（5 个 query 验证），且小项目 AI 直接 Read spec 完全够用，原 manifest + recall 子命令组在当前规模下是过度设计。

### `init` 重跑不再吞 yaml 注释

之前 init 用 `parse + stringify` 会丢所有注释。改用 yaml lib 的 Document API（`parseDocument` + 在 AST 上 set），init 真正成为幂等操作。Dogfooding forecast-market-api 时发现的隐藏 bug。

### 稳定身份匹配，根治 zombie wiki 节点

修复 sync 改 OpenAPI `summary` / `tagAlias` 会产生 zombie wiki 节点的 bug。
现在 sync 用 spec 派生的稳定身份键作为 join key，title 只是显示。

#### 修复 / 行为变化

- **叶子节点身份键 = `METHOD + path`**：以前用整个 title 做匹配，summary 一改就 miss 然后 createWikiChild 新建 + 留旧节点。现在 cascade 匹配：`node-map.json` 已知 nodeToken → 从已有 title 抽 `METHOD path` → 旧 title 完全匹配 → 创建新节点。匹配上以后如果 title 不同，下推时传 `--new-title` 把 wiki 侧边栏标题改过来。
- **Tag / Group 中间节点持久化身份**：新增 `.openapi-lark/node-map.json`（gitignored，与 sync-lock 同目录）维护 `tagId → nodeToken` / `tagId/groupKey → nodeToken` 映射。`tagAliases` 改名时不再造 zombie tag。
- **`push()` 始终传 `--new-title`**：endpoint 模式下每次 docs +update 都强制锁定 wiki 节点 + docx 标题为 spec 派生值，避免 lark-cli 的 overwrite 模式从 markdown body 里挑 H1 当标题导致漂移。
- **末尾 zombie 报告**：sync 结束后 stderr 列出 pool 里未被认领的旧节点（标题 / nodeToken / wiki URL），方便人工 review 是否真的过时。不自动删，要清理就去 wiki 手动 archive。
- **`.openapi-lark/node-map.json` 不进 git**：跟 sync-lock / auto-tokens 一样 per-project local。第一次 sync 时通过 title 抽 `METHOD path` 回填，能覆盖大多数升级场景。

#### 新文件

- `src/node-map.ts` + `test/node-map.test.ts`（14 tests）
- `src/lark/child-pool.ts` + `test/child-pool.test.ts`（12 tests）

#### 影响面

- 用户首次 sync 时 leaf 通过 title 抽身份回填 node-map；若 title 完全不可解析（曾被手动改过），fallback 到原有 title 匹配，最坏不会比当前更差。
- `--new-title` 需要 lark-cli >= 1.0.32（init 已强制 >=1.0.34）。
- **本次只修了 `mode: endpoint`**。`mode: tree` / 单文件模式的同名问题（tagAlias 改名造 tag zombie）作为后续 issue 处理。

### 实测验证（forecast-market-api dogfood）

跑新版 sync 在 forecast-market-api 上：52 个 endpoint 全 skipped（sha256 match），末尾 stderr 列出 **11 个 zombie wiki 节点**（6 leaf + 5 tag/intermediate），每条带 nodeToken + objToken + URL，用户能直接判断是否清理。

### 测试

251 tests 全过；tsc 干净；build 干净。

## 0.1.0 — 2026-05-20

First release. OpenAPI → 飞书 docx 文档同步工具。Lark-native API platform 的第一块拼图，替代 yapi 接口文档管线。

### Features

- **5 个子命令**：`init` / `lint` / `render` / `sync` / `doctor`
- **GitHub 源分发**：`npx skills add leeguooooo/openapi-lark`；不发 npm registry
- **配置层**：`.openapi-lark.yaml` 支持 `extends` 单层继承 + `${ENV_VAR}` 环境变量插值（extends 合并先于 env 插值，确保子配置能覆盖父的 env 引用）
- **渲染**：widdershins 默认引擎，针对飞书 docx 优化（lang_tabs 限 curl、删除 unsafe HTML 标签、表格内 `|` 转义、heading 越级 warn-only）；`--engine native` 占位但未实现（v1.5）
- **Push**：shell out 到 `lark-cli`，`--json` 优先 + regex 兜底；120s per-service timeout，失败按 auth/permission/timeout/non-zero 分类
- **并发**：`--parallel <n>` 用 p-limit；按声明顺序输出汇总报告
- **诊断**：`doctor` 检查 lark-cli 装否 / 版本约束 / openapi resolved size

### Spec & QA

- 设计文档：`docs/superpowers/specs/2026-05-20-openapi-to-lark-skill-design.md`
- 7 轮 codex review 通过（4 轮 spec + 3 轮 code）
- 60 个测试全过；tsc 零错；dist build 干净

### KNOWN_ISSUES（飞书 docx markdown quirks，已有对策）

1. 宽表格溢出 — widdershins 默认 ≤4 列，一般不触发
2. 表格内 `|` 破坏解析 — post-process 自动转义内容 pipe（separator 位置匹配 + 右到左 claim）
3. HTML 标签丢失 — post-process 删除 `<br>` `<sub>` `<sup>` `<details>` `<summary>`
4. 嵌套/多语言 code fence 乱码 — widdershins 配置只输出 curl 一个语言 tab
5. Heading 越级被拍平 — remark/mdast walk 检测并 warning，不自动改 md

### 文档治理警告

被同步的飞书 docx 由本工具拥有，每次 sync 覆盖全文。手写内容、评论、锚点会丢失。
正确做法：sync 目标 docx 当只读展示文档。讨论 / 协作 → 另开节点。

### v2+ 规划

- v1.1 — lark-cli `--json` 上游推动 + push 层去 regex 兜底
- v1.5 — 自渲 markdown engine（`--engine native`）
- v2.0 — API diff + Lark Bot 通知
- v2.1 — MCP Tool 生成
- v2.5 — SDK 生成

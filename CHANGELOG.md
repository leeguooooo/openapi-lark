# Changelog

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

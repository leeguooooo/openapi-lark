---
name: openapi-lark
description: 把项目 api/openapi.yaml 同步到飞书 docx 文档。用于替代 yapi 文档管线，作为 Lark-native API platform 的第一块拼图。Trigger 当用户说「同步接口文档到飞书」「openapi 推到飞书」「替换 yapi」「lark docs from openapi」「飞书 API 文档自动化」时。
---

# openapi-lark — OpenAPI → 飞书 docx

> 决策规则：何时跑哪条命令，多服务怎么组织，故障怎么诊。
> 命令的具体 flag 看 `openapi-lark <cmd> --help`，不在本文件里维护（避免与 CLI 漂移）。

## 安装

一次性：

```bash
npx skills add leeguooooo/openapi-lark
```

之后所有命令走 `npx -y -p github:leeguooooo/openapi-lark openapi-lark <cmd>`，
本 skill 已在调用前缀里嵌好。

## 工作流决策树

```
用户给了什么？
├─ 项目里还没 .openapi-lark.yaml
│   └─ 先跑 `openapi-lark init --name <svc> --openapi <path> --doc-url <feishu url>`
│       目标 docx 不存在 → 先用 `lark docs +create` 建一个，复制 URL 再 init
├─ 项目里已经有 .openapi-lark.yaml，但用户改了 openapi
│   └─ 跑 `openapi-lark sync`（或指定单个 service）
├─ 用户问「飞书文档样式不对」
│   └─ 跑 `openapi-lark render <svc>` 拿到本地 md → 看 ./.openapi-lark/<svc>.md
│       结合 KNOWN_ISSUES 排查（README 顶部）
├─ 用户问「环境配置对吗」/ 「lark-cli 是不是缺了」
│   └─ 跑 `openapi-lark doctor`
└─ 用户问「不推送只看效果」
    └─ 跑 `openapi-lark sync --dry-run`
```

## 多服务组织建议

- **同一团队多个微服务**：在每个服务的 repo 根放 `.openapi-lark.yaml`，每个 service 用自己的 docToken。不要把所有服务的 docToken 都塞进一个仓库
- **跨仓库共用 docToken 池**：用 `extends: ./shared/lark-docs.yaml` 引用同一份基础配置；子配置只覆盖差异
- **多环境（dev / staging / prod）**：docToken 用 `${LARK_DOC_VOICE_ROOM_PROD}` 之类的 env 引用；CI 注入不同环境的 token

## 故障诊断序

按下面顺序，每一步通过再进下一步：

1. `openapi-lark doctor` — 环境层（lark-cli、auth、resolved size）
2. `openapi-lark lint` — 配置层（schema、openapi 语法、env 变量）
3. `openapi-lark render <svc>` — 渲染层（widdershins 输出 + heading 越级 warning）
4. `openapi-lark sync --dry-run` — 端到端不推送
5. `openapi-lark sync <svc>` — 真推送（先单 service 验证再批量）

## 不要做的事

- **不要在被同步的 docx 里手写内容**：sync 会覆盖全文，手写部分会丢失。文档由本工具拥有。
- **不要在 CI 里直接跑 sync 不带 --parallel**：服务多了串行很慢；但也不要 `--parallel` 超过 4，飞书服务端限速
- **不要用 `--engine native`**：v1 没实现，会 exit 2。v1.5 才会有
- **不要把 docToken 直接硬编码进 yaml**：用 `${LARK_DOC_X}` env 引用，便于跨环境

## 退出码语义

| code | 含义 |
|---|---|
| 0 | 成功（含 warning） |
| 1 | 业务失败（per-service：渲染 / push 失败） |
| 2 | 配置错误（missing yaml / schema 失败 / env 未注入 / 不允许的参数） |
| 3 | 环境错误（lark-cli 缺失 / 版本不达标 / auth 失效） |

---
name: openapi-lark
description: 把项目 api/openapi.yaml 同步到飞书 docx / wiki 文档树。用于替代 yapi 文档管线，作为 Lark-native API platform 的第一块拼图。Trigger 当用户说「同步接口文档到飞书」「openapi 推到飞书」「替换 yapi」「lark docs from openapi」「飞书 API 文档自动化」「按 tag 拆文档」「每个接口一个文档」时。
---

# openapi-lark — OpenAPI → 飞书 docx / wiki tree

> 决策规则：何时跑哪条命令，多服务怎么组织，故障怎么诊。
> 命令的具体 flag 看 `openapi-lark <cmd> --help`，不在本文件里维护（避免与 CLI 漂移）。

## 安装

一次性：

```bash
npx skills add leeguooooo/openapi-lark
```

之后所有命令走 `npx -y -p github:leeguooooo/openapi-lark openapi-lark <cmd>`，
本 skill 已在调用前缀里嵌好。

## 三种 sync 模式

`.openapi-lark.yaml` 的 `services[].mode` 字段决定结构：

| mode | 飞书呈现 | 适用 |
|---|---|---|
| `single`（默认） | 单个 docx 装所有内容 | 小 openapi（< 600 KB md），单文档够看 |
| `tree` | 父 docx + 每 tag 一个子 wiki 节点 | 中等规模，按 tag 分组 |
| `endpoint` | 父 docx + 每 tag 中间节点 + 每接口一个叶子 | 大规模 / 想每个接口独立可链接（推荐） |

endpoint mode 是默认推荐：
- 用户用飞书 wiki 树导航时直接看接口标题（中文 summary 在前）
- 单接口文档体积小，渲染快、不撞飞书 1MB 上限
- 修一个接口只重推一个 doc

## 工作流决策树

```
用户给了什么？
├─ 项目里还没 .openapi-lark.yaml
│   └─ 先跑 `openapi-lark init --name <svc> --openapi <path> --doc-url <feishu url>`
│       目标 docx 不存在 → 先用 `lark-cli docs +create --api-version v2` 建一个
│       想要文件树 → init 后手工把 mode 改成 endpoint，添 tagAliases / parentTitle
├─ 项目里已经有 .openapi-lark.yaml，但用户改了 openapi
│   └─ 跑 `openapi-lark sync`
│       内容没变的接口会被 hash cache 自动 skip（sync-lock.json）
│       想强推：加 --force
├─ 用户问「飞书标题不对 / 父节点标题被改了」
│   └─ 在 config 里加 parentTitle: "<期望名>"；下次 sync 自动锁定
├─ 用户问「飞书呈现样式 / 段落看不懂」
│   └─ 跑 `openapi-lark render <svc>` 拿到本地 md → 看 ./.openapi-lark/<svc>.md
│       v1.4+ 已经做：中文优先标题 / 段落本地化 / operationId→summary
│       结合 README KNOWN_ISSUES 排查
├─ 用户问「环境配置对吗 / lark-cli 缺了」
│   └─ 跑 `openapi-lark doctor`
└─ 用户问「不推送只看效果」
    └─ 跑 `openapi-lark sync --dry-run`
```

## 配置参考

```yaml
engines:
  larkCli: ">=0.1.0"

# v1.5: maxPushBytes 默认 600 KB。voice-room 这类大 openapi 拆 endpoint mode
# 后每个接口都很小（~10-30 KB），不用调整
maxPushBytes: 600000

# Lockfile 路径：.openapi-lark/sync-lock.json（自动生成，加进 .gitignore）

services:
  - name: voice-room
    openapi: api/openapi.yaml
    docToken: Uc6hwkXXXX                # 父 wiki 节点 token（不是 docx token！）
    mode: endpoint                       # single | tree | endpoint
    parentTitle: 语音房                   # 强制锁定父 wiki 标题（防被 widdershins 偷）
    tagAliases:                          # 中文化 tag 显示名
      "语音房": "语音房接口"
      "管理端": "管理端接口"
    includeTags: [基础服务, 语音房]       # 可选：只同步这些 tag
    excludeTags: []                      # 可选：跳过这些 tag
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
5. `openapi-lark sync <svc>` — 真推送（首次会 push 全部；之后只推内容变了的）
6. `openapi-lark sync --force` — 跳过 hash cache 强推（修复疑似不同步）

## 飞书 lark-cli 鉴权

sync 用到的 scope：
- `space:document:read` + `space:document:edit`（基础 push）
- `wiki:node:write`（创建子 wiki 节点）
- `wiki:node:move`（清理 zombie 节点 / 重组）

如果缺 scope，doctor 不会单独检查但 sync 失败会报 `missing required scope(s): X`。
解决：

```bash
lark-cli auth login --scope "wiki:node:move space:document:delete"
```

会输出 verification URL，浏览器打开授权后 CLI 自动拿新 token。

## 不要做的事

- **不要在被同步的 docx 里手写内容**：sync 会覆盖全文，手写部分会丢失。文档由本工具拥有。
- **不要在 CI 里直接跑 sync 不带 --parallel**：服务多了串行很慢；但也不要 `--parallel` 超过 4，飞书服务端限速
- **不要用 `--engine native`**：v1 没实现，会 exit 2
- **不要把 docToken 直接硬编码进 yaml**：用 `${LARK_DOC_X}` env 引用，便于跨环境
- **endpoint mode 首次 sync 慢是正常的**（每接口要 createWikiChild + push，voice-room 167 个 ~16 分钟）；之后 hash cache 让重跑只推变化的接口（几秒级）

## 退出码语义

| code | 含义 |
|---|---|
| 0 | 成功（含 warning / skipped） |
| 1 | 业务失败（per-service：渲染 / push 失败） |
| 2 | 配置错误（missing yaml / schema 失败 / env 未注入 / 不允许的参数） |
| 3 | 环境错误（lark-cli 缺失 / 版本不达标 / auth 失效） |

## 已知行为（不是 bug）

- 首次同步前**应在飞书 wiki 手工创建一个父节点**作为容器；--doc-url 用它
- docx +update --command overwrite 会清空 docx，**评论 / 锚点会丢失**。被 openapi-lark 拥有的 docx 不要参与协作讨论
- widdershins 渲染的某些 heading 越级（H2→H4）只能 warn，不能自动改 md
- 删 wiki zombie 节点需要 `space:document:delete` scope，且对 wiki-托管的 docx 仍 forbidden；用 `lark-cli wiki +move --target-space-id <别处>` 是有效的「移除」手段

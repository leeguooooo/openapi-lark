# openapi-lark

> **OpenAPI → 飞书 wiki / docx 同步工具**。把 `api/openapi.yaml`（或 chanfana / Hono / FastAPI / NestJS Swagger 的 `/openapi.json` URL）当真相源，自动渲染成飞书 wiki 文档树。**替代 yapi 的接口文档管线**。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-green)](https://nodejs.org)
[![lark-cli](https://img.shields.io/badge/lark--cli-%E2%89%A51.0.34-orange)](https://github.com/larksuite/cli)
[![Skill](https://img.shields.io/badge/Claude%20Code-skill-purple)](https://github.com/leeguooooo/openapi-lark)

```
api/openapi.yaml ─┐
                  ├─→ openapi-lark sync ─→ 飞书 wiki tree
http(s)://.../openapi.json (NEW v1.10) ─┘
```

每个接口一个独立 wiki 子节点，标题 `<中文 summary> — <METHOD> <path>`。改 1 个接口重 sync 只推那 1 个（hash 缓存）。

---

## 为什么做这个

- **yapi 不再维护**，团队需要新的接口文档承载层
- **飞书 wiki 是国内团队默认协作空间**，让接口文档原地可读、可搜、可订阅
- **OpenAPI 是真相源**：CI 跑一次同步，飞书永远是最新；不用维护两份
- **不卡 PR**：sync 走本机 OAuth，不需要在 CI 配密钥（也能配，看你团队）

## ✨ 主要能力

- ✅ **本地文件 + http(s) URL 双源** — runtime 生成的 OpenAPI（chanfana / Hono / FastAPI / NestJS Swagger）直接拉，不再 commit 过期快照
- ✅ **三种渲染模式** — `single` / `tree`（按 tag 分组）/ `endpoint`（每接口一个 wiki 子节点，推荐）
- ✅ **每接口可搜可链** — wiki 标题统一 `<summary> — <METHOD> <path>`，飞书搜索秒命中
- ✅ **中文优先** — 接口标题中文 summary 在前、参数/响应表中文化、所有 widdershins 套话已本地化
- ✅ **allOf 自动扁平** — BaseResponse + 业务字段不再渲染成 `Inline`，完整字段表 + 自动合成 JSON 响应示例
- ✅ **hash 缓存** — 内容没变的接口自动 skip，二次同步秒级回
- ✅ **多 service 单 wiki 父节点** — 一个项目 N 份 openapi（admin / game / internal）自动建 N 个兄弟子节点
- ✅ **dry-run 真不推线上**（v1.10 修复）— 本地预览看渲染效果，零服务端调用
- ✅ **doctor 真验 auth + scope**（v1.10）— 调 `lark-cli auth check` 提前发现缺 scope / token 过期
- ✅ **Claude Code / Codex skill** — agent 自己跑命令，用户只用说人话
- ✅ **CI 友好** — `--dry-run` 本地预览、`--force` 跳缓存、`--parallel N` 控制速率、退出码语义化

## 📦 安装

### 作为 CLI

```bash
# 一次性运行（推荐）
npx -y -p github:leeguooooo/openapi-lark openapi-lark --help

# 或全局装上
npm i -g github:leeguooooo/openapi-lark
```

### 作为 Claude Code / Codex skill

```bash
npx skills add leeguooooo/openapi-lark
```

装上后跟 agent 说人话即可。详见 [SKILL.md](./SKILL.md)。

### 前置：lark-cli

```bash
# 官方安装（任意平台）
npx @larksuite/cli@latest install

# 登录（推荐 --recommend 一次开足常用 scope）
lark-cli auth login --recommend
```

需要 lark-cli ≥ 1.0.34（`auth check` 子命令）。详见 [larksuite/cli](https://github.com/larksuite/cli)。

## 🚀 快速开始（3 步）

### 1. 在飞书 wiki 手工创建一个空父节点

复制它的 URL，形如 `https://<host>/wiki/<TOKEN>`。

> ⚠️ 不要复用有内容的节点——sync 会清空它。

### 2. 项目根 init

```bash
cd <project>
npx -y -p github:leeguooooo/openapi-lark openapi-lark init \
  --name <svc> \
  --openapi api/openapi.yaml \
  --doc-url <wiki url>
```

生成的 `.openapi-lark.yaml` 默认带 `mode: endpoint` + 从 `info.title` 推出的 `parentTitle`。

### 3. 同步

```bash
# 先 dry-run 本地预览（v1.10 起真不推线上）
openapi-lark sync --dry-run

# 真同步
openapi-lark sync
```

首次同步 ~5-15 分钟（取决于接口数）；之后 hash 缓存让重跑变秒级。

## 🌐 URL openapi 源（v1.10 新）

不用再 `curl > api/openapi.json` 维护过期快照。chanfana / Hono / FastAPI / NestJS Swagger 项目把 runtime 的 `/openapi.json` 端点直接接进来：

```yaml
services:
  - name: ai-girls
    openapi: https://ai-girls.example.workers.dev/openapi.json
    # 可选：鉴权头（${ENV} 插值）
    openapiHeaders:
      Authorization: "Bearer ${OPENAPI_TOKEN}"
    # 可选：每次 sync 同时落盘一份，便于 PR diff review
    openapiSnapshot: api/openapi.snapshot.json
    mode: endpoint
    docToken: ${LARK_DOC_AI_GIRLS}
```

`doctor` 自动改用 HEAD 探活、`lint` 走带鉴权的 fetch——URL 源不会被误报 "file not found"。

## 🎯 三种渲染模式

`.openapi-lark.yaml` 的 `services[].mode` 决定结构：

| mode | 飞书呈现 | 适用 |
|---|---|---|
| `single` | 单个 docx 装所有内容 | 小 openapi（<600 KB 渲染后） |
| `tree` | 父 docx + 每 tag 一个子 wiki 节点 | 中等规模，按 tag 分组够用 |
| `endpoint` ⭐ | 父 docx + 每 tag 中间节点 + **每接口一个叶子** | **推荐**：大规模、可独立链接、单文档体积小 |

```
endpoint mode 飞书 wiki 树形示意：

📁 <parentTitle>
├── 📁 用户接口 (tag)
│   ├── 📄 注册 — POST /api/user/register
│   ├── 📄 登录 — POST /api/user/login
│   └── ...
├── 📁 房间接口 (tag)
│   ├── 📁 voice-room (path-prefix 子组，≥8 接口时自动)
│   │   ├── 📄 创建语音房间 — POST /api/voice-room/create
│   │   ├── 📄 加入语音房间 — POST /api/voice-room/join
│   │   └── ...
│   └── 📁 text-room
└── ...
```

## ⚙️ 配置参考

```yaml
# .openapi-lark.yaml — 提交进 git
engines:
  larkCli: ">=1.0.34"           # auth check 需要 1.0.34+

# 可选：一个 wiki 父节点 + N 个 service 自动建子节点
# parentDocToken: ${LARK_WIKI_PARENT}

services:
  - name: voice-room                  # 服务名（lockfile + 输出目录用这个）
    openapi: api/openapi.yaml         # 本地文件 或 http(s):// URL
    # openapiHeaders:                 # URL 源专用
    #   Authorization: "Bearer ${TOKEN}"
    # openapiSnapshot: api/snapshot.json  # URL 源专用，落盘 diff
    docToken: ${LARK_DOC_VOICE_ROOM}  # 父 wiki 节点 token
    mode: endpoint                     # single | tree | endpoint
    parentTitle: 语音房                 # 强制锁定父 wiki 标题
    tagAliases:                        # 可选：中文化 tag 显示名
      "voice-room": "语音房接口"
    includeTags: [基础服务, 语音房]      # 可选：只同步这些 tag
    excludeTags: []                    # 可选：跳过这些 tag
    render:
      engine: widdershins              # v1 唯一可用

# 可选高级项
maxPushBytes: 1000000                  # 默认 600 KB；飞书 1MB+ 必超时
pushTimeoutMs: 120000                  # 默认 120s
maxResolvedSizeBytes: 52428800         # 默认 50 MB
larkBin: lark                          # 默认 lark-cli；某些发行版叫 lark
extends: ./shared/base.yaml            # 跨 repo 共用基础配置（单层）
```

`.openapi-lark/` 目录是缓存 + lockfile，加进 `.gitignore`。

## 📋 命令清单

```
openapi-lark init      生成或追加 .openapi-lark.yaml（默认 mode:endpoint + 推 parentTitle）
openapi-lark lint      校验配置 + openapi 语法（URL 源也支持）
openapi-lark render    仅生成本地 md 到 .openapi-lark/<svc>/
openapi-lark sync      端到端同步（preflight → render → push）
openapi-lark sync --dry-run    本地渲染 + 假节点演练，零服务端调用
openapi-lark sync --force      跳过 hash 缓存强推
openapi-lark sync --parallel N  并发 service 数（CI 控制速率，建议 ≤4）
openapi-lark doctor    环境诊断：lark-cli / auth status / scope check / openapi reachability
```

每个命令 `--help` 看完整 flag。

## 🩺 doctor / 诊断

```bash
$ openapi-lark doctor
  ✓ config                     /path/to/.openapi-lark.yaml
  ✓ lark-cli                   lark-cli 1.0.35 satisfies >=1.0.34
  ✓ auth                       tokenStatus=valid, 119 scope(s) (expires 2026-05-22T...)
  ✓ auth.scopes                granted: wiki:node:read, wiki:node:create, docx:document:write_only
  ✓ service:ai-girls.openapi   URL → HTTP 200, 406.2 KB (HEAD probe)
  · service:ai-girls.docToken  authoritative permission check requires real lark API call (v2)

6 ok / 0 failed / 1 skipped
```

doctor 现在用 `lark-cli auth check --scope "..."` 真验 scope（不再像 v1.9 之前给假 ok），token 6 小时内过期会警告。

## 🔐 鉴权 scope（飞书开放平台官方名）

> 实测：`wiki:node:write` 不存在，飞书会返回 invalid scope。下表是 2026-05 官方文档校对过的名字。

| 操作 | 推荐 scope（细粒度） | 兜底（粗粒度） |
|---|---|---|
| 读 docx 内容 | `docx:document:readonly` | `docx:document` |
| 创建 / 更新 docx | `docx:document` | — |
| 读 wiki 节点信息 | `wiki:node:read` | `wiki:wiki:readonly` |
| 创建 wiki 子节点 | `wiki:node:create` | `wiki:wiki` |
| 移动 wiki 节点（清理 zombie） | `wiki:node:move` | `wiki:wiki` |

懒人模式：

```bash
lark-cli auth login --recommend       # 一次开足官方推荐 scope
```

## ⚠️ 文档所有权

**`openapi-lark` 同步到的飞书 docx 由本工具拥有。每次 sync 覆盖全文。**

- 被同步的 docx 里**手写的任何内容会丢失**
- 评论 / 锚点 / 人工书签可能丢失或漂移
- **不要把工具同步的 docx 当协作画板**

正确做法：sync 目标是**只读展示文档**；要讨论的话题另开节点 → 评论 / 加链接。

## 📏 大小限制（飞书 docx v2 实测）

| markdown 大小 | 结果 |
|---|---|
| ≤ 500 KB | ✓ `result: success` |
| ~ 200 KB（截断） | ⚠ `partial_success` |
| ≥ 1 MB | ✗ `server time out`（60s 后失败） |

默认 `maxPushBytes: 614400`（600 KB）pre-check 渲染大小。**endpoint mode** 单 leaf 一般 10-30 KB，几乎撞不到。

## 🔢 退出码

| code | 含义 |
|---|---|
| 0 | 成功（含 warning / skipped） |
| 1 | 业务失败（per-service：渲染 / push） |
| 2 | 配置错误（yaml 缺失 / schema 失败 / env 未注入） |
| 3 | 环境错误（lark-cli 缺失 / 版本不达标 / auth 失效） |

## 🐛 已知行为（不是 bug）

- **widdershins heading 越级（H2→H4）只 warn 不自动修** — 自动改 md 会引入飞书空标题；修源头（openapi 描述）更安全
- **lark docx 不支持折叠块** — JSON 示例放在 `### 响应示例` 子标题下，靠 wiki 大纲折叠
- **删除 wiki zombie 节点** — `drive +delete` 对 wiki-托管 docx 返 forbidden；用 `lark-cli wiki +move` 移走是有效"清除"手段
- **`--engine native` 占位未实现** — 传入会 exit 2

## 🤝 vs 其他方案

| | openapi-lark | yapi | swagger-ui | redoc |
|---|---|---|---|---|
| 真相源 | OpenAPI yaml/json | yapi 后台手维护 | OpenAPI | OpenAPI |
| 飞书 wiki 集成 | ✅ 原生 | ❌ | ❌ | ❌ |
| 中国团队搜索体感 | ✅ 飞书搜索 | ⚠ 自建 | ⚠ 静态 | ⚠ 静态 |
| 维护状态 | active | 2022 起停更 | active | active |
| URL 源（runtime spec） | ✅ v1.10 | ⚠ webhook | ✅ | ✅ |
| 每接口可独立链接 | ✅ endpoint mode | ✅ | ⚠ 锚点 | ⚠ 锚点 |
| AI agent 友好（skill） | ✅ Claude Code / Codex | ❌ | ❌ | ❌ |

## 🛠️ 开发

```bash
npm install
npm run build       # tsc
npm test            # vitest (158 tests)
npm run lint        # tsc --noEmit
```

设计文档：`docs/superpowers/specs/2026-05-20-openapi-to-lark-skill-design.md`。

## 📝 License

MIT © leeguooooo

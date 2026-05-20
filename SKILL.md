---
name: openapi-lark
description: 把项目 api/openapi.yaml 同步到飞书 docx / wiki 文档树。支持 single / tree / endpoint（每接口一个 wiki 子节点）三种结构，自动按 tag 拆分、中文优先标题、allOf 扁平化、响应字段表 + JSON 示例、hash 缓存。用于替代 yapi 文档管线。Trigger 当用户说「同步接口文档到飞书」「openapi 推到飞书」「替换 yapi」「lark docs from openapi」「飞书 API 文档自动化」「按 tag 拆文档」「每个接口一个文档」「openapi-lark」时。
---

# openapi-lark — OpenAPI → 飞书 docx / wiki tree

> 决策规则：何时跑哪条命令，多服务怎么组织，故障怎么诊。
> 命令的具体 flag 看 `openapi-lark <cmd> --help`，不在本文件里维护（避免与 CLI 漂移）。

## 安装

一次性：

```bash
npx skills add leeguooooo/openapi-lark
```

之后所有命令走 `npx -y -p github:leeguooooo/openapi-lark openapi-lark <cmd>`，本 skill 已在调用前缀里嵌好。

**前置：**
- lark-cli 已安装（`brew install lark-cli`）+ 已登录 `lark-cli auth login`
- 项目里有 `api/openapi.yaml`（或任意路径的 openapi 3.x yaml/json）

## 多 service 项目（一个 wiki URL 接 N 个 openapi）

v1.8 新支持：项目里有多个 openapi spec（admin / game / internal / ...），用户只给一个 wiki 父节点 URL。工具自动在该父节点下建 N 个兄弟子节点，每个 service 一个。

```yaml
# .openapi-lark.yaml
parentDocToken: XJ51wLKIXidz...    # ← 用户给的 wiki URL 解析出来的 token
services:
  - name: admin
    openapi: api/generated/admin/openapi.json
    parentTitle: 管理端 API          # ← 自动创建的子节点标题
    mode: endpoint
  - name: game
    openapi: api/generated/game/openapi.json
    parentTitle: 用户端 API
    mode: endpoint
  - name: game-internal
    openapi: api/generated/game-internal/openapi.json
    parentTitle: 内部 API
    mode: endpoint
  - name: sports-event
    openapi: api/generated/sports-event/openapi.json
    parentTitle: 体育赛事 API
    mode: endpoint
```

首次 sync 自动建 4 个子节点；token 存到 `.openapi-lark/auto-tokens.json`（gitignored），后续 sync 复用。

## 单 service 项目（一个 openapi 一个 wiki URL）

```
[1] 飞书 wiki 创建父节点
    在你的 wiki space 里手工新建一个 docx 节点（比如标题 "项目 X API"）。
    复制 URL，形如 https://<host>/wiki/<TOKEN>

[2] 项目根 init
    cd <project>
    npx -y -p github:leeguooooo/openapi-lark openapi-lark init \
      --name <svc> \
      --openapi api/openapi.yaml \
      --doc-url <wiki url>

[3] 编辑 .openapi-lark.yaml，至少加这几项：
    services:
      - name: <svc>
        ...
        mode: endpoint             # 强烈推荐 endpoint 模式
        parentTitle: <项目 X>       # 防止父节点标题被覆盖

[4] 首次同步（~5-15 分钟，取决于接口数）
    openapi-lark sync

[5] 再次同步（hash 缓存生效，几秒）
    openapi-lark sync
```

把 `.openapi-lark.yaml` 和 `.gitignore`（加 `.openapi-lark/`）提交进 git。

## 三种 sync 模式

`.openapi-lark.yaml` 的 `services[].mode` 字段决定结构：

| mode | 飞书呈现 | 适用 |
|---|---|---|
| `single`（默认） | 单个 docx 装所有内容 | 小 openapi（<600 KB 渲染后），单文档够看 |
| `tree` | 父 docx + 每 tag 一个子 wiki 节点 | 中等规模，按 tag 分组够用 |
| `endpoint` | 父 docx + 每 tag 中间节点 + 每接口一个叶子 | 大规模 / 想每接口独立可链接（推荐） |

**endpoint mode 是默认推荐**：
- 用户在飞书 wiki 树侧栏看到的就是每个接口标题（中文 summary 在前）
- 每个接口独立 docx，单文档体积小、撞不到飞书 1MB 上限
- 修一个接口只重推一个 doc（hash 缓存）
- tag 中间节点只是 TOC（不会膨胀）

## 工作流决策树

```
用户给了什么？
├─ 项目里还没 .openapi-lark.yaml
│   └─ 用上面「新项目快速开始」
├─ 已有 .openapi-lark.yaml，用户改了 openapi
│   └─ openapi-lark sync
│       内容没变的接口被 hash cache 自动 skip
│       想强推：加 --force
├─ 用户问「飞书父节点标题被改成 Authentication / Untitled 了」
│   └─ 在 config 加 parentTitle: "<期望名>"；下次 sync 自动锁定
├─ 用户问「响应字段表只有 default 没有 200」/ 「字段不全」
│   └─ 已自动修复（v1.7+ 内置 allOf 扁平化 + 完整 schema 展开）
│       老的 sync-lock.json 删掉重跑一次即可
├─ 用户问「能不能给接口加请求/响应示例」
│   └─ v1.7+ 已自动从 schema 合成 JSON 响应示例
├─ 用户问「飞书呈现样式 / 段落看不懂」
│   └─ openapi-lark render <svc> → ./.openapi-lark/<svc>/ 看本地 md
│       中文优先标题 / 段落本地化 / operationId→summary 都已生效
├─ 用户问「环境配置对吗 / lark-cli 缺了」
│   └─ openapi-lark doctor
├─ 用户问「lark-cli 提示 missing scope」
│   └─ 见下方「鉴权 scope」节
└─ 用户问「不推送只看效果」
    └─ openapi-lark sync --dry-run
```

## 配置参考（完整）

```yaml
engines:
  larkCli: ">=0.1.0"

# 可选：覆盖底层 lark-cli 二进制名（默认 lark-cli；旧版本叫 lark）
# larkBin: lark

# 可选：每接口推送大小上限（默认 600 KB；endpoint mode 一般用不到）
# 注：飞书 docx server 实测 1MB+ 必超时；endpoint-split 之后每个 leaf
# 一般 10-30 KB
maxPushBytes: 1000000

# 可选：跨 repo 共用基础配置
# extends: ./shared/lark-docs.yaml

# Lockfile 路径：.openapi-lark/sync-lock.json（自动生成；加进 .gitignore）

services:
  - name: voice-room                 # 服务名（lockfile + 输出目录用这个）
    openapi: api/openapi.yaml        # 相对项目根
    docToken: Uc6hwkXXXX             # 父 wiki 节点 token（不是 docx token！）
                                     # 用 ${LARK_DOC_X} env 引用更好
    mode: endpoint                    # single | tree | endpoint
    parentTitle: 语音房                # 强制锁定父 wiki 标题（防止被偷）
    tagAliases:                       # 中文化 tag 显示名
      "语音房": "语音房接口"
      "管理端": "管理端接口"
      "Lucky Game": "幸运游戏接口"
    includeTags: [基础服务, 语音房]     # 可选：只同步这些 tag
    excludeTags: []                   # 可选：跳过这些 tag
```

## 多服务组织建议

- **同一团队多个微服务**：在每个服务的 repo 根放 `.openapi-lark.yaml`，每个 service 用自己的 docToken。不要把所有服务的 docToken 都塞进一个仓库
- **跨仓库共用 docToken 池**：用 `extends: ./shared/lark-docs.yaml` 引用同一份基础配置；子配置只覆盖差异
- **多环境（dev / staging / prod）**：docToken 用 `${LARK_DOC_VOICE_ROOM_PROD}` 之类的 env 引用；CI 注入不同环境的 token

## 搜索 / 查接口（跨项目）

当 agent 在另一个项目里被问「voice-room 创建房间接口长啥样」「查一下 POST /api/xxx 的参数」时，**不要新装搜索工具**——直接用 lark-cli 搜飞书 wiki，配合本 skill 的命名规律就行。

**命名规律（openapi-lark 同步出的 wiki 节点）：**

| wiki 节点层级 | 标题格式 | 例子 |
|---|---|---|
| 项目根 | `<parentTitle>` 或服务名 | `语音房` |
| tag 中间节点 | `<tagAliases[tag]>` 或 tag id | `语音房接口` |
| path-prefix 子组（≥8 接口时自动产生） | 第一段路径名 | `voice-room` / `tags` / `badges` |
| **接口叶子** | **`<summary> — <METHOD> <path>`** | `创建语音房间 — POST /api/voice-room/create` |

agent 看到标题里有 ` — METHOD ` 就知道这是个接口叶子，不是组。

**典型搜索套路：**

```bash
# 按业务关键词搜（最常用）
lark-cli drive +search --query "创建房间" --type docx
# 结果里 title 含 ` — POST ` / ` — GET ` 的就是接口叶子
# 拿 obj_token 后：
lark-cli docs +fetch --api-version v2 --doc <obj_token> --scope outline
# 即可读到该接口完整文档（参数表、响应表、JSON 示例）

# 按方法+路径搜
lark-cli drive +search --query "POST /api/voice-room/create" --type docx

# 列出某项目所有接口（先拿父节点 token，再列子节点递归）
lark-cli wiki +node-list --space-id <X> --parent-node-token <project parent> --page-all
# 再对每个 tag 中间节点递归列子节点 → 拿到所有接口标题
```

**agent 的最佳实践（写进对话脚本里）：**

1. 用户问「X 接口长啥样」→ `lark-cli drive +search --query "X" --type docx`
2. 结果过滤：保留 title 匹配 ` — (GET|POST|PUT|DELETE|PATCH) ` 的条目
3. 没命中：换关键词；命中 1 条：直接 `docs +fetch` 展开
4. 命中多条：让用户选，或显示 title + path

**为什么这套行得通：**
- title 锁定（lockTitleInMarkdown）保证每个 docx 标题都是 `<summary> — <METHOD> <path>`
- 一行就能眼判是不是接口
- summary 是中文 → 自然语言搜索能命中
- METHOD + path 是英文 → 精确技术搜索也能命中

## 鉴权 scope

`lark-cli auth login` 默认 scope 够用于基础读写。但下列操作需要额外 scope：

| 操作 | scope |
|---|---|
| 创建 / 更新 docx | 默认已有 |
| 创建 wiki 子节点 | `wiki:node:write`（默认通常有） |
| **清理 zombie 节点（move）** | `wiki:node:move` |
| **删除 docx**（少见） | `space:document:delete`（但 wiki 托管的 docx 仍 forbidden，需用 move） |

需要时跑：

```bash
lark-cli auth login --scope "wiki:node:move space:document:delete"
```

会输出 verification URL，浏览器打开授权后 CLI 自动拿新 token。

## 故障诊断序

按下面顺序，每一步通过再进下一步：

1. `openapi-lark doctor` — 环境层（lark-cli、auth、resolved size）
2. `openapi-lark lint` — 配置层（schema、openapi 语法、env 变量）
3. `openapi-lark render <svc>` — 渲染层（widdershins 输出 + heading 越级 warning）
4. `openapi-lark sync --dry-run` — 端到端不推送
5. `openapi-lark sync <svc>` — 真推送（首次会 push 全部；之后只推内容变了的）
6. `openapi-lark sync --force` — 跳过 hash cache 强推（修复疑似不同步）

## v1.7 已自动处理的渲染细节

不需要你做任何配置，sync 时自动生效：

- **中文优先标题**：endpoint 标题是「<summary> — <METHOD> <path>」
- **allOf 扁平化**：BaseResponse + 业务字段的常见包装会被完整展开成单表
- **段落本地化**：Parameters→参数 / Responses→响应 / Response Schema→响应 Schema / Enumerated Values→枚举值 / 等
- **operationId → summary**：`## getXxx` 替换为 `## 获取 XXX`
- **响应 JSON 示例**：从 schema 合成真实示例值（用 example/format/enum/类型默认值），末尾 `### 响应示例 (200)`
- **删多余 boilerplate**：widdershins 的 Code samples / 200 Response 错误 dump / aside / Generator 注释 / 空 H1 等全部 strip
- **docx title 锁定**：每个 docx 唯一 H1 = 我们的目标标题（lark 用 first H1 当 title）

## 不要做的事

- **不要在被同步的 docx 里手写内容**：sync 会覆盖全文，手写部分会丢失。文档由本工具拥有。
- **不要在 CI 里 `--parallel` 超过 4**：飞书服务端会限速
- **不要用 `--engine native`**：v1 没实现，会 exit 2
- **不要把 docToken 直接硬编码进 yaml**：用 `${LARK_DOC_X}` env 引用，便于跨环境
- **不要在飞书 wiki 已有内容的节点上 init**：sync 会清空它。专门建一个新 docx 给本工具用。
- **endpoint mode 首次 sync 慢是正常的**（每接口要 createWikiChild + push，167 个 ~8-16 分钟）；之后 hash cache 让重跑变成秒级

## 退出码语义

| code | 含义 |
|---|---|
| 0 | 成功（含 warning / skipped） |
| 1 | 业务失败（per-service：渲染 / push 失败） |
| 2 | 配置错误（missing yaml / schema 失败 / env 未注入 / 不允许的参数） |
| 3 | 环境错误（lark-cli 缺失 / 版本不达标 / auth 失效） |

## 已知行为（不是 bug）

- **首次同步前应在飞书 wiki 手工创建一个父节点作为容器**；--doc-url 用它
- **docx +update --command overwrite 会清空 docx**，评论 / 锚点会丢失。被 openapi-lark 拥有的 docx 不要参与协作讨论
- **删除 wiki zombie 节点**：drive +delete 对 wiki-托管 docx 返 forbidden；用 `lark-cli wiki +move --target-space-id <别处>` 移走是有效的「清除」手段
- **lark docx 不支持真正的「折叠块」**（markdown 和 XML 都不支持 collapse 容器）；JSON 示例放在 `### 响应示例` 子标题下，用户可通过 wiki 大纲折叠
- widdershins 渲染的某些 heading 越级（H2→H4）只能 warn，不能自动改 md

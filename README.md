# openapi-lark

OpenAPI → 飞书 docx 文档同步工具。**Lark-native API platform** 的第一块拼图。

替代 yapi 接口文档管线。把 `api/openapi.yaml` 当真相源，飞书 docx 当展示层。

```
api/openapi.yaml ─→ openapi-lark sync ─→ 飞书 docx
```

---

## ⚠️ 文档所有权

**`openapi-lark` 同步到的飞书 docx 由本工具拥有。每次 sync 覆盖全文。**

后果：
- 在被同步的 docx 里**手写的任何内容会丢失**
- 评论 / 锚点 / 人工书签可能丢失或漂移
- 不要把工具同步的 docx 和团队协作的 wiki 节点混用

正确做法：sync 目标 docx 是**只读展示文档**。需要讨论 / 协作的话题 → 另开节点 → 评论或加链接。

---

## 安装

```bash
npx skills add leeguooooo/openapi-lark   # Claude Code / Codex skill
# 或直接调用 CLI：
npx -y -p github:leeguooooo/openapi-lark openapi-lark --help
```

不发布到 npm registry。源在 GitHub。首次会 git clone + npm install，后续走缓存。

## 快速开始

1. 先在飞书新建一个 docx（用 lark-cli 或网页），复制 URL
2. 项目根跑：
   ```bash
   openapi-lark init \
     --name voice-room \
     --openapi api/openapi.yaml \
     --doc-url https://feishu.cn/docx/XXXXXXXX
   ```
3. 检查生成的 `.openapi-lark.yaml`，按需调 `engines.larkCli`
4. 同步：
   ```bash
   openapi-lark sync
   ```

## 配置示例

```yaml
# .openapi-lark.yaml — 提交进 git
engines:
  larkCli: ">=0.1.0"
pushTimeoutMs: 120000          # 可选，默认 120s
maxResolvedSizeBytes: 52428800 # 可选，默认 50 MB
extends: ./shared/base.yaml    # 可选，单层
services:
  - name: voice-room
    openapi: api/openapi.yaml
    docToken: ${LARK_DOC_VOICE_ROOM}
    render:
      engine: widdershins      # v1 唯一可用
```

`.openapi-lark/` 目录是渲染缓存，建议加进项目 `.gitignore`。

## 命令清单

```
openapi-lark init      生成或追加 .openapi-lark.yaml
openapi-lark lint      校验配置 + openapi 语法（离线）
openapi-lark render    仅生成 md 到 ./.openapi-lark/<svc>.md
openapi-lark sync      端到端：preflight → render → push 覆盖飞书 docx
openapi-lark doctor    诊断 lark-cli / auth / docToken / resolved size
```

每个命令用 `openapi-lark <cmd> --help` 看 flag。

## 退出码

| code | 含义 |
|---|---|
| 0 | 成功（含 warning） |
| 1 | 业务失败（渲染 / push） |
| 2 | 配置错误（yaml 缺失 / schema 失败 / env 未注入） |
| 3 | 环境错误（lark-cli 缺失 / 版本不达标 / auth 失效） |

## KNOWN_ISSUES（飞书 docx markdown quirks）

下面 5 项是预先识别的踩坑，渲染层已做对策。如果你看到这些症状，先对照本节，再决定要不要报 bug：

1. **宽表格溢出 / 截列**：飞书把宽表格按页面宽度截掉后续列。**对策**：超 5 列的 schema 表会被自动拆分（v1.1 起）；v1 目前 widdershins 默认 4 列，一般不会触发
2. **表格单元里的 `|` 破坏解析**：openapi description 里出现 `|` 会让整行表格断裂。**对策**：渲染后处理自动 `\|` 转义
3. **HTML 内联标签丢失**：`<details>` `<br>` `<sub>` 等在飞书 docx 中显示为原文或被吞。**对策**：渲染后处理移除 `<details>` `<summary>` `<br>` `<sub>` `<sup>` 标签
4. **嵌套 / 多语言 code fence 乱码**：嵌套 ` ``` ` 飞书必乱。**对策**：widdershins 配置只输出 curl 一个 language tab，关闭 lang_tabs
5. **Heading 越级被拍平 → 锚点漂移**：H4 直接接 H2 时飞书拍平为同层。**对策**：渲染后用 `remark/mdast` 检测并 warning（带行号 + 标题文本）；不自动改 md（自动插占位会在飞书产生可见空标题，副作用更大）。看到 warning 自行修 widdershins 模板 / openapi 描述层级

## 当前限制（v1）

- 默认渲染引擎只有 widdershins；`--engine native` 占位但未实现，传入会 exit 2（见 spec Phase v1.5）
- 不支持 watch 模式 / 文件变更自动同步
- 不做 API diff 检测（见 spec Phase v2）
- 不生成 MCP Tool / SDK（见 spec Phase v2.1 / v2.5）
- CI/CD 接入需自己写（用 lark-cli 本机登录的 token，或注入 LARK_APP_ID/SECRET 走 v2 鉴权）
- Windows 未验证（macOS/Linux only）

## 开发

```bash
npm install
npm run build
npm test
```

设计文档：见上游仓库的 `docs/superpowers/specs/2026-05-20-openapi-to-lark-skill-design.md`。

## License

MIT

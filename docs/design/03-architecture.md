# 5. 架构与技术选型

> 本文是主设计文档 [`../design.md`](../design.md) 的拆分章节；索引与章节导航见该文件。


- **形态**：本机 Web 应用 + AI 双入口。`npm start` 启动本地服务并自动打开浏览器；CLI（`taskboard`）与 MCP server（stdio）与 Web 共用同一核心 store，可独立运行、不要求 Web 服务在跑
- **后端**：Node.js ≥ 22.5（本机 22.22）+ `express` + 内置 `node:sqlite`（无原生依赖）；MCP 用官方 `@modelcontextprotocol/sdk`，CLI 用内置 `util.parseArgs`；git 操作（show / diff / log / merge / merge-tree 预检）用 `simple-git` 调本机 git
- **前端**：Vite + Vue 3 + Element Plus（`el-table` 树形数据做展开树、`el-drawer` 做右侧详情、`el-dialog` 做属性定义编辑）；文档编辑用 **Vditor**（编辑 / 预览 / 图片上传）；diff 预览与冲突处理用 **CodeMirror 6 + @codemirror/merge**（MergeView 支持逐块接受 / 拒绝）。Vditor 的图标 / mermaid / KaTeX 等资源**自托管**（静态目录 + `cdn` 配置），不依赖外网 CDN
- **错误处理**：统一错误体 `{ error: { code, message, details? } }`

模块划分：

```
task-board/
  package.json          # 根脚本：start / dev / test / smoke
  server/
    index.js            # 启动、静态资源托管（含 /uploads）、路由挂载、打开浏览器
    config.js           # config.json 读写、默认值、600 权限、token 打码
    db.js               # 打开库、建表与迁移、WAL、外键、预置 attr_defs
    store.js            # nodes / attrs / documents / commits / mrs 数据访问 + 类型校验 + 级联 + 排序
    git.js              # 本机 git 操作：show / diff / log、branch / worktree、merge、merge-tree 冲突预检
    gitlab.js           # GitLab API 客户端（项目 MR 查询、连通性测试、diff 兜底）
    api.js              # REST 路由与统一错误处理（含图片上传）
    mcp.js              # MCP server（stdio）：把核心能力暴露为工具
    cli.js              # CLI 命令实现（tree / node / attr / doc / repo / unit / commit / diff / merge / conflict / mr / batch / import / schema）
  bin/
    taskboard.js        # CLI 可执行入口（npm link 后可直接 `taskboard`）
  web/
    index.html
    src/App.vue                    # 壳 + 路由（列表 / 属性定义 / 设置）
    src/views/TreeView.vue         # 表格式展开树
    src/views/AttrDefsView.vue     # 属性定义管理
    src/views/SettingsView.vue     # GitLab / 端口 / 状态值域
    src/components/NodeDrawer.vue  # 右侧详情抽屉（动态表单 + 文档区 + commits + MR）
    src/components/MarkdownEditor.vue  # Vditor 封装：编辑 / 预览、图片上传
    src/components/DocPane.vue     # 文档区：左列文档名（增 / 改 / 排 / 删）+ 右侧渲染 / 编辑
    src/components/DiffPane.vue    # commit 预览：文件列表 + CodeMirror diff（统一 / 分栏 / 全文）
    src/components/ConflictPane.vue # 冲突处理：MergeView 逐块接受 / 拒绝 / 手改 + 产出补丁
    src/api.js
  test/                 # node:test 用例
  README.md
```

- 数据：`~/.taskboard/data.db`；附件图片：`~/.taskboard/uploads/`；配置：`~/.taskboard/config.json`
- 代码位置：`/Users/xuchen.xia/charge2/task-board/`（新建独立 git 仓库）
- 依赖：`express`、`@modelcontextprotocol/sdk`（MCP server）、`simple-git`（本机 git 操作）、`vue`、`element-plus`、`vditor`（Markdown 编辑 / 预览）、`@codemirror/*`（diff 预览与冲突处理）、`sortablejs`（同级拖拽排序）、`vite`、`@vitejs/plugin-vue`；其余使用 Node 内置能力（fetch / sqlite / test / util.parseArgs）
- 将来共享：存储层（`store.js`）与 HTTP 层分离，替换数据库 + 增加登录与 `owner` 字段即可升级为多人服务

### 5.1 AI 友好约定（v1 必须满足）

- **引用**：所有工具与接口同时接受 `id` 与路径（`项目A/需求1/子需求2`）
- **读取**：`tree --format md` 输出缩进 markdown 树；`node show --with=attrs,commits,mrs`
- **发现**：`schema` 返回节点类型、状态值域、属性定义与工具清单（AI 不必猜字段）
- **写入**：`node upsert --path`（get-or-create，幂等）、`attr set`（单项更新）、`doc upsert`（按文档名写正文）、`batch`（多步一次调用）；均支持 `--dry-run`
- **导入**：`import --format md` 用缩进大纲一次落成整棵子树
- **工作区**：`unit setup` 按规则建分支 + worktree（支持多仓库）并返回开发提示词；`unit prompt` 刷新提示词；`unit cleanup` 清理（合并后默认保留）
- **代码集成**：`merge precheck` 只读预检（`merge-tree --name-only -z`，NUL 分隔解析）；`merge run --confirm` 逐仓库 `merge --no-ff` 并写 `merges` 行；冲突走 `precheck_conflict` → `merge confirm|abort`；成功合并后恢复发起前 HEAD
- **破坏性操作**：删除 / 移动需显式 `--confirm`（接口 `confirm: true`），未确认返回 400 `CONFIRM_REQUIRED`
- **错误**：统一 `{ error: { code, message, details } }`，错误码稳定，`details` 定位到字段 / 路径
- **并发**：SQLite WAL + `busy_timeout=5000`，Web / CLI / MCP 三方直接读写同一库
- **变更可见**：任何写入使 `GET /api/revision` 递增（**一次用户 / AI 操作只递增一次**，组合写入不重复计数）；前端每 10 秒轮询并自动刷新
- **预览与冲突**：`diff` 读单 commit / 节点（含子树）的 diff；`merge precheck` 预检；`merge run` 执行合并；`conflict show` 返回 base / ours / theirs 三方内容；`conflict resolve` 写回合并结果与补丁（AI 可直接处理冲突）
- **工具清单**：MCP 工具与 CLI 命令是 §6 REST 能力的 1:1 映射（schema / tree / node / attr-def / doc / repo / unit / commit / diff / merge / conflict / mr / batch / import / upload）
- **文档**：README 附「给 AI 的用法」（工具清单 + 示例 + bootstrap prompt）

### 5.2 仓库结构与文档同源（功能之家）

约定：**一个目录就是一个功能的家**，文档与代码同步推进、一起提交。

```text
task-board/
  docs/design.md              # 主设计文档（权威副本；评审版在工作区 docs/superpowers/specs/）
  features/README.md          # 功能索引（功能 → 目录 → 计划 → 状态 → 代码位置）
  features/<功能目录>/
    prd.md                    # 功能需求（目标 / 需求点 / 验收标准）
    design.md                 # 功能设计（模块职责 / 关键规则 / 接口 / 错误码 / 与主设计文档对应）
    commit.md                 # 该功能的提交记录：一行一条 commit message
  server/                     # 代码按分层组织（errors / config / db / store，后续 git•api•mcp•cli）
  test/                       # node:test 用例
  web/                        # 前端（计划 3 起）
```

规则：

1. 每个功能目录只放文档三件套（`prd.md` / `design.md` / `commit.md`），不放代码；代码在 `server/`、`test/`、`web/`，靠 `features/README.md` 的索引对应。
2. 提交前把本次 commit message 追加进所属功能的 `commit.md`，与该功能代码在同一次提交入库；跨功能的提交在每个被触碰的功能里各记一行。
3. 新增或拆分功能时同步建目录与三份文档，并在 `features/README.md` 索引里登记。
4. 功能粒度对齐 §2.1 的 v1 功能清单；目录清单见 `features/README.md`。

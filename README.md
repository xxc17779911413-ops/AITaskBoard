# task-board

以树形方式组织研发任务的本地任务管理器：项目 → 需求 → 子需求 → 任务组（可嵌套）→ 子任务（+ 缺陷）。

- **AI 是主要操作者**：同一套核心能力同时开放给 Web / HTTP API / CLI / MCP 四个入口
- 纯本地运行：Node 内置 SQLite，数据落在 `~/.taskboard/`，无需外部服务
- **配套 IDE 插件**（本仓库内）：`idea-plugin/`（IDEA 任务板插件：需求树 / Review / PRD tab / Agent 控制台）、`idea-layout-manager/`（窗口布局管理）

## 快速开始

```bash
git clone git@github.com:xiaxuchen/task-management.git
cd task-management
npm install     # postinstall 会自动把 Vditor 资源同步到 web/public/vditor/dist
npm run build   # 构建前端到 web/dist/
npm start       # 起服务并打开浏览器（默认 http://127.0.0.1:3210）
```

要求 **Node ≥ 22.5**（用到内置 `node:sqlite`）。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 起 HTTP 服务；端口取配置，被占用则自动 +1（最多 +10） |
| `npm run dev` | Vite 开发服务器（5173，`/api` 代理到 3210） |
| `npm run build` | 构建前端（前置 `prepare:vditor` 同步 Vditor 资源） |
| `npm test` | 全部单测 + 集成测试（`node:test`） |
| `npm run smoke` | 冒烟测试 |
| `node bin/taskboard.js tree --format md` | CLI 入口（`npm link` 后可直接 `taskboard`） |
| `node server/import-dsh.mjs --dry-run` | 预览 dsh-charge 需求同步（不写库） |
| `node server/import-dsh.mjs --reset` | 重建导入 dsh-charge 需求 |
| `npm run snapshot:export` | 把 `~/.taskboard/data.db` 导成 `data/snapshot.json`（文本快照，可入 git / 备份；覆盖全部业务表，漏登记表会直接报错）|
| `npm run snapshot:import` | 从 `data/snapshot.json` 恢复到本地库（幂等，会自动重映射主键与外键）|

## 运行时数据

| 路径 | 说明 |
|---|---|
| `~/.taskboard/data.db` | SQLite 数据（WAL + 外键） |
| `~/.taskboard/config.json` | 端口 / GitLab token / 状态值域 / 文档预置名（权限 600） |
| `~/.taskboard/uploads/` | 文档图片 |
| `TASKBOARD_HOME` | 环境变量，可整体切换数据目录（测试指向临时目录以实现隔离） |

> 数据要跨机器带或纳入版本管理，用 `npm run snapshot:export` 生成 `data/snapshot.json`（**不要**直接提交 `data.db`：二进制不可 diff，且 `-wal`/`-shm` 会丢数据；`config.json` 含 token 永不入库）。

## 文档

| 文档 | 内容 |
|---|---|
| `AGENTS.md` | **给 AI 编码助手的项目指引**：分层约定 · 提交规范 · 文档维护规范 · 测试规范 · AI 操作入口（MCP/CLI）· 关键约束 · 已知坑 —— **让 AI 动手前先读它** |
| `docs/design.md` | **主设计文档（总览）**：背景与目标 · 范围（v1 包含/不包含）· 后续演进 + **章节导航表** |
| `docs/design/` | 主设计文档的 10 个章节文件（概念模型 / 数据模型 / 架构与选型 / 接口清单 / 关键流程 / UI / 错误码 / 测试策略 / 24 条决策 / 术语）—— **按需只读需要的章节** |
| `docs/api.md` | **接口速查**：关键 REST 接口的请求 / 响应示例与 curl |
| `docs/README.md` | **文档索引**：各文档作用与权威性 · 设计文档关系 · 更新规则 |
| `docs/plans/` | 实施计划（按子系统拆分，含任务级步骤与验收）|
| `features/README.md` | **功能索引**：功能 → 目录 → 所属计划 → 状态 → 代码位置 |
| `features/<功能>/prd.md` | 该功能的需求（目标 / 需求点 / 验收标准） |
| `features/<功能>/design.md` | 该功能的设计（模块职责 / 关键规则 / 踩过的坑） |
| `features/<功能>/commit.md` | 该功能的提交记录（一行一条 commit message） |

## 计划进度

- [x] 计划 1 数据层（config / db / store：节点·属性·文档·revision）
- [x] 计划 2 三入口（HTTP API + CLI + MCP，ops 共享能力层 + 集成测试）
- [x] 计划 3 Web UI（Vite + Vue3 + Element Plus + Vditor：表格式展开树 + 右侧抽屉 + 文档区 + 设置/属性定义）
- [x] 配套：dsh-charge 需求同步导入（按 task-board 规格撰写）
- [ ] 计划 4 Git 集成与冲突处理
- [ ] 计划 5 MR 拉取 / 上传 / 冒烟

## 目录约定（功能之家）

每个功能一个目录：`features/<slug>/`，只放 `prd.md`（功能需求）/ `design.md`（功能设计）/ `commit.md`（该功能的提交记录）；代码在 `server/`、`test/`、`web/` 按分层组织。索引见 `features/README.md`，主设计文档在 `docs/design.md`。

**提交约定**：每次提交同步把 commit message 追加进所属功能的 `commit.md`，与其代码在同一次提交入库；跨功能的提交在每个被触碰的功能里各记一行。

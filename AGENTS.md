# AGENTS.md

> 给 AI 编码助手（Qoder / Claude Code / Cursor / Codex 等）的项目指引。
> 人类用户请先看 [README.md](./README.md)。
> 若你要在这个仓库里动手，**先读完本文件**。

## 这是什么

`task-board` —— 以树形组织研发任务的**本地**任务管理器：
`项目 → 需求 → 子需求 → 任务组（可嵌套）→ 子任务（+ 缺陷）`。

**核心原则：AI 是主要操作者**（不是人）。这决定了所有接口设计：MCP + CLI 双入口、
按 id/路径引用节点、schema 自描述、幂等写入、稳定机器可解析错误码、操作者审计。
Web UI 面向人但是次要入口。

## 快速上手

```bash
npm install && npm run build   # 装依赖 + 构建（postinstall/prebuild 会自动同步 Vditor 资源）
npm start                      # 起服务 → http://127.0.0.1:3210
npm test                       # 55 个用例（node:test）
npm run snapshot:export        # 把 ~/.taskboard/data.db 导成 data/snapshot.json
npm run snapshot:import        # 从 data/snapshot.json 恢复本地库（幂等）
```

要求 **Node ≥ 22.5**（用内置 `node:sqlite`）。

## 动手前必做两件事

1. **读设计文档** → `docs/design.md`（**总览 + 章节导航**，88 行）
   它本身很短；正文按章节拆在 `docs/design/`（10 个文件）—— **按需只读你要的那节**：
   `01-concepts` 概念模型 · `02-data-model` 数据表 · `03-architecture` 架构选型 · `04-api` 接口清单 · `05-flows` 关键流程 · `06-ui` · `07-errors` 错误码 · `08-testing` · `09-decisions` 24 条决策 · `10-glossary` 术语
2. **读目标功能文档** → `features/<功能>/{prd,design}.md`，索引在 `features/README.md`

**运行时自描述**（比静态文档更准，用它代替猜字段）：

```bash
node bin/taskboard.js schema      # 等价于 MCP 工具 schema / GET /api/schema
```

返回：节点类型与各自允许的子类型、状态值域（每类节点的可用集合）、属性定义、工具清单。

## 目录结构与分层（不要打破）

```
server/
  store.mjs       ← 唯一读写核心：nodes / attrs / documents / commits / repos
                     + 父子类型校验 / 成环检测 / 级联删除 / 同级排序 / revision
  ops.mjs         ← 共享能力层：buildSchema / renderTreeMd / upsertByPath /
                     parseOutline / importOutline / applyBatch
  http.mjs        ← express 路由（只做参数装配 + 错误映射，不写业务逻辑）
  cli.mjs         ← CLI 入口（复用 ops + store）
  mcp.mjs         ← MCP server（复用 ops + store）
  index.mjs       ← 启动 + 静态托管 web/dist + SPA 回退
  import-dsh.mjs  ← dsh-charge 需求导入（唯一直接写 SQL 的地方，见「关键约束」）
bin/taskboard.js  ← CLI 可执行 shim
web/src/          ← Vue3 SFC：App.vue / views/ / components/ / api.js
test/             ← node:test：store-*.test.mjs / ops.test.mjs / http.test.mjs
features/<功能>/  ← 功能之家：只放 prd.md / design.md / commit.md（不放代码）
docs/design.md    ← 主设计文档权威副本
```

**铁律**：HTTP / CLI / MCP 三个入口**必须复用 `store.mjs` + `ops.mjs`**。
新增能力要三处同步暴露，否则人与 AI 看到的能力会不一致。

## 提交规范（强制）

1. **Conventional Commits**：`type(scope): 描述`
   - `type` ∈ `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf`
   - **`scope` 必须用功能目录名**：`feat(entrypoints)`、`fix(tree-table-ui)`、`docs(dsh-import)`
   - ❌ 不要用阶段名/计划号做 scope（如 `feat(plan2)`）
2. **功能之家登记**：每次提交必须把 commit message **追加一行**到所属功能的
   `features/<功能>/commit.md`，并与其代码在**同一次提交**入库。
   跨功能的提交，在每个被触碰的功能里各记一行。
3. **新功能**要同步建 `features/<slug>/` 三件套，并在 `features/README.md` 索引登记。

## 文档维护规范（强制）

| 变更类型 | 必须更新 |
|---|---|
| 新增/修改接口（REST / MCP / CLI） | `docs/design/04-api.md`（接口表）+ `docs/api.md`（示例）+ 对应 `features/*/design.md` |
| 数据模型（表 / 字段） | `docs/design/02-data-model.md` |
| 新增决策（选型、方案取舍） | `docs/design/09-decisions.md` |
| 功能行为变化、踩过的坑 | 该功能 `features/<功能>/design.md` |
| 架构 / 分层变化 | `docs/design/03-architecture.md` + 本文件 |

## 测试规范

- 全部 `node:test`；**`npm test` 必须全绿才能提交**
- 分组：数据层 `test/store-*.test.mjs`｜共享能力 `test/ops.test.mjs`｜HTTP `test/http.test.mjs`（进程内 express + 随机端口 + fetch）
- 隔离靠 `TASKBOARD_HOME` 指向临时目录 —— **不要**在用例里碰真实 `~/.taskboard`
- 改 `store` / `ops` 时补对应用例；修 bug 先写出能复现的失败用例

## AI 操作入口

**MCP 工具（与 REST 接口 1:1；权威清单以 `schema` 返回为准）**

```
读取  schema · tree · node_get · attr_defs · doc_list · commit_list · repo_list · config_get
写入  node_upsert · node_update · node_delete · node_reorder
      requirement_list · requirement_create · requirement_transition
      document_overview
      attr_set · attr_add · attr_update · attr_remove
      doc_upsert · doc_create · doc_update · doc_remove · doc_reorder · doc_version_list · doc_version_restore
      commit_add · commit_remove · repo_add · repo_update · repo_remove · config_set
      upload_image
工作区  unit_repo_list · unit_repo_add · unit_repo_remove · unit_setup · unit_prompt · unit_cleanup
批量  batch · import_outline
门禁  requirement_readiness · mindmap · delivery_gate
设计  design_outline · design_outline_apply
门禁  requirement_readiness · secret_scan · delivery_gate
门禁  requirement_readiness · delivery_gate
      交付快照 delivery_snapshot_capture · delivery_snapshot_list · delivery_snapshot_get
回归  test_case_list · test_case_upsert · test_case_update · test_case_remove · test_case_reorder
      test_run · test_report_list · test_report_get · test_report_finish · acceptance_report
      acceptance_status · acceptance_sign
上线  release_item_list · release_item_upsert · release_item_update · release_item_remove · release_item_reorder
      release_checklist · release_check
agent 运行时  runtime_list · runtime_register · runtime_heartbeat · runtime_status · runtime_remove
agent 会话    agent_session_list · agent_session_new · agent_session_archive
agent 任务    agent_run · agent_runs_list · agent_run_get · agent_run_messages
              agent_run_cancel · agent_run_retry · agent_run_update
```

**agent 三层模型**（对齐 multica）：运行时（机器级 CLI 实例，daemon_id + provider 唯一）→
会话（节点上一个 agent 的可续跑对话，沉淀 `cliSessionId` / `workDir`）→ 任务（一次执行，
`attempt` / `parentRunId` 串重试链）；任务输出按 `seq` 落消息流，UI 用 `sinceSeq` 增量拉取。
派单缺省会自动注册本机运行时并复用该节点的活动会话。

**CLI**（`node bin/taskboard.js <cmd>`；`npm link` 后可省前缀）

```bash
tree --format md                       # 读现状（输出可直接喂给 import）
schema                                 # 发现能力（节点类型/状态值域/属性定义）
node get "项目A/需求1"                  # ref 可为 id 或路径
node upsert --path "项目A/需求1"        # get-or-create，幂等
attr set "项目A/需求1" status=doing     # 单项属性更新
doc upsert "项目A/需求1" --name 需求内容 --file desc.md   # 按文档名幂等
upload ./shot.png                                      # 上传文档图片 → { url: "/uploads/<name>" }
unit repo add "项目A/需求1/任务1" --repo-id 1          # 登记工作单元涉及仓库
unit setup "项目A/需求1/任务1" [--dry-run]              # 建分支 + worktree，返回开发提示词
unit prompt "项目A/需求1/任务1"                         # 生成 / 刷新开发提示词（纯读）
unit cleanup "项目A/需求1/任务1" --confirm [--keep-branch]   # 清理工作区（未并入「声明基线」的分支会保留）
import --file outline.md --dry-run     # 大纲导入，先预演
batch --file ops.json                  # 多步一次调用
node delete <ref> --confirm            # 破坏性操作必须 --confirm

runtime list                           # 运行时列表（含在线状态与总览）
agent session list "项目A/需求1"        # 该节点上的会话（可续跑标注）
agent session new "项目A/需求1" --title 评审
agent run "项目A/需求1" --prompt "跑单测" --resume   # 派单；--resume 续跑会话
agent runs "项目A/需求1"                # 任务历史
agent run messages <rid>               # 任务消息流（事件流）
agent run cancel <rid> / agent run retry <rid>
agent run update <rid> --status success --cli-session <id>   # 前台执行者回写
test case upsert "项目A/需求1" --name 登录回归 --prompt "跑登录单测" [--enabled false]   # 写用例（按名幂等）
test run "项目A/需求1" --kind regression [--dry-run]        # 派单执行 + 自动开报告
test report finish <rid> --status pass --summary 全绿 [--run-id N] [--overwrite]   # 回写报告终态（终态互转需 --overwrite）
test acceptance "项目A/需求1" [--scope subtree] [--format md]  # 验收报告
test acceptance-status "项目A/需求1" [--scope subtree] [--format md]  # 验收签收状态（测试证据 + 业务签收）
test acceptance-sign "项目A/需求1" --decision accepted|rejected [--comment "验收意见"]  # 签收 / 驳回
readiness check "项目A/需求1" [--scope subtree] [--format md]  # 需求就绪门禁（需求内容 + 概要设计 + 可回归用例）
mindmap "项目A/需求1" [--scope subtree] [--max-depth N] [--format md]  # 思维导图（mermaid mindmap 只读投影）
design outline "项目A/需求1" [--scope subtree] [--format md]   # 概要设计大纲 / 思维导图（从需求树推导骨架）
design apply "项目A/需求1" [--scope subtree] [--overwrite]     # 写入「概要设计」文档（默认不覆盖已填写内容）
secret scan "项目A/需求1" [--scope subtree] [--format md]      # 文档敏感信息扫描（只读，命中值脱敏）
delivery gate "项目A/需求1" [--scope subtree] [--format md]    # 交付门禁（需求就绪 + 测试验收 + 上线治理的最终汇总）
delivery snapshot "项目A/需求1" [--note 备注]                  # 冻结当前交付证据（完整依据 + 指纹）
delivery snapshots "项目A/需求1" [--scope subtree]             # 快照列表（current / drifted）
delivery snapshot-get <sid> [--format md]                       # 单条快照（可贴验收 / 上线记录）

release item upsert "项目A/需求1" --name "执行上线 SQL" --kind sql --content "ALTER TABLE …" --rollback "DROP …"
release item list "项目A/需求1" [--kind config|sql|check] [--status pending|ready|done|blocked|skipped]
release item update <rid> --status done              # 必做项 done/skipped 才算完成
release checklist "项目A/需求1" [--scope subtree] [--format md]   # 上线检查清单（就绪结论 + 阻塞项）
release check "项目A/需求1" [--scope subtree] [--dry-run] [--no-wait]   # 派单上线前置检查（code/biz/release_check 用例）
```

> **CLI 派单默认等收尾**：`test run` / `release check` 非 dry-run 时会等到 agent 任务落终态、
> 并把关联报告自动收尾后才返回（上限 `--wait-timeout 秒`，缺省 30 分钟）；`--no-wait` 退回只派单语义。
> 与 HTTP / MCP 一样能在同一次调用里拿到终态，避免留下一堆永远 `running` 的报告与任务。

**推荐工作流**

1. `schema` 发现节点类型 / 状态值域 / 属性定义 —— **不要猜字段**
2. `tree --format md` 读现状
3. 先 `--dry-run` 预演，再落库
4. 单点更新用 `node upsert` / `attr set`（幂等，可反复调用）
5. 破坏性操作（删除 / 移动）必须带 `--confirm`（HTTP 侧为 `confirm: true`），否则 400 `CONFIRM_REQUIRED`

**写操作会记录 actor**：CLI 默认 `cli`，MCP 为 `mcp`（早期工具为 `ai`），Web 为 `user`，导入为 `import`；
可用 `--actor ai` 覆盖。值域外一律回退 `user`（`store.mjs` 的 `ACTORS` 单点校验）。UI 上有徽标区分。
**写操作会记录 actor**：CLI 默认 `cli`，MCP 工具的显式回写为 `mcp`，Web 为 `user`，导入为 `import`，
服务内部为 `system`；CLI 可用 `--actor ai` 覆盖。UI 上有徽标区分。

## 关键约束（不要做）

- ❌ **不要绕过 `store.mjs` 直接写库做业务逻辑** —— `import-dsh.mjs` 是唯一例外
  （它需要精确控制 revision 与文档预置时机；即便如此也要自行保证数据约束与 store 一致）
- ❌ 不要给 HTTP / CLI / MCP 各写一套业务逻辑
- ❌ 不要不加 `--confirm` 就删除 / 移动；不要跳过 `commit.md` 登记
- ❌ 不要把大文件提交进 git（Vditor 的 21.9 MB 资源已在 `.gitignore` 的 `web/public/vditor/`）
- ❌ **不要把 `~/.taskboard/config.json` 或 `data.db` 提交进 git** —— 前者含 GitLab token，
  后者是二进制且带 `-wal`/`-shm`（直接拷会丢未 checkpoint 的数据）。要带数据走用
  `npm run snapshot:export` 生成 `data/snapshot.json`（文本、可 diff、可回放）
- ❌ 不要把 token 写进代码或数据库 —— 只存 `~/.taskboard/config.json`（600 权限），接口返回时打码
- ❌ 不要在 `features/<功能>/` 里放代码 —— 那里只放三份文档
- ❌ **不要给快照写手工表清单** —— 快照的表集合与顺序都从 schema 推导
  （`scripts/snapshot-tables.mjs`：`sqlite_master` − `EXCLUDED_TABLES`，导入顺序按外键拓扑排序）；
  新增表**自动进快照**。手工清单一定会漂移，会让快照静默丢表（XPX-151：曾丢 10+ 张表）

## 已知坑（别再踩）

| 坑 | 说明 |
|---|---|
| **改完前端却看到旧页面** | `index.html` 已设 `Cache-Control: no-cache`。若仍异常：确认跑过 `npm run build`、再让浏览器强刷（曾因启发式缓存把 Vditor 版误判成「不支持链接」的旧版）|
| **Vditor 自动保存不触发** | Vditor 的 `input` 回调**触发时机不可靠**（实测输入后数秒仍未回调）。`DocPane.vue` 用 900ms **轮询** `getValue()` 与已存内容比对来驱动保存；轮询必须在 `after` 回调里启动（构造后立即 `getValue()` 会静默失效）；防抖定时器只能在「内容真正变化」时重置，否则会被轮询无限推迟 |
| **Vditor 资源 404** | 路径规则是 `${cdn}/dist/js/...`，物理目录必须落在 `web/public/vditor/dist`（配 `cdn='/vditor'`）；`npm install` / `npm run build` 会自动同步 |
| **快照悄悄丢表** | `snapshot:export` 曾只导最早 9 张表，新增的 `test_cases` / `release_items` / `comments` / `agent_*` 等被静默丢掉（导出/导入都不报错）。现在表集合从 schema 推导、新增表自动纳入，无需人工登记；加表后跑 `npm test`（`test/snapshot.test.mjs` 断言覆盖与往返）。别再加手工清单 |
| **快照导入把关系写成 NULL** | 自引用列（`nodes.parent_id` / `agent_runs.parent_run_id`）**不能边插边解析**：父行 id 不保证小于子行（真实库就有 7 条「子 id < 父 id」），先插入的子行找不到父 id，合法外键被静默写成 `NULL`。**`NULL` 是合法外键值，行数守恒与 `IS NOT NULL` 孤儿检查都测不出来**——必须「先插入全部行、同一事务内再统一回填」，并用逐行关系断言（`test/snapshot.test.mjs`）验证。外键/关系类数据别用行数代替关系断言 |
| **Express 5 通配符** | 不支持 `app.get('*')`；SPA 回退用 `app.use` 中间件判断 `req.path` 前缀 |
| **revision 语义** | 一次操作只递增 1；组合写入（建节点 + 写属性 + 预置文档）用 `withoutBump` 包裹 |
| **路径引用歧义** | 同级存在同名节点时用路径会 409 `PATH_AMBIGUOUS`，改用 `id` |
| **导入脚本的 attr_def 残留** | `--reset` 只清节点树，不清 `attr_defs`（属配置）；改了属性规划要手工清旧定义 |

## 文档导航

| 想了解 | 看 |
|---|---|
| 产品需求与设计全貌 | `docs/design.md`（总览 + **章节导航表**）|
| 数据表结构 | `docs/design/02-data-model.md` + `server/db.mjs` 的 `SCHEMA` |
| 接口清单 | `docs/design/04-api.md`（或直接调 `schema`）|
| 接口请求 / 响应示例 | `docs/api.md` |
| 关键流程（建树 / 合并 / 冲突…）| `docs/design/05-flows.md` |
| 错误码清单 | `docs/design/07-errors.md` + `server/errors.mjs` |
| 技术决策记录（24 条）| `docs/design/09-decisions.md` |
| 文档总索引与更新规则 | `docs/README.md` |
| 实施计划 | `docs/plans/` |
| 某功能的需求 / 设计 / 提交记录 | `features/<功能>/` |
| 功能清单与状态 | `features/README.md` |
| 人类上手 | `README.md` |

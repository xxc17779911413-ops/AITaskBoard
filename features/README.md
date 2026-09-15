# 功能之家（features/）

约定（用户 2026-09-11 定）：**一个目录就是一个功能的家**。

- 每个功能目录只放文档：`prd.md`（功能需求）、`design.md`（功能设计）、`commit.md`（该功能的提交记录，一行一条 commit message）。
- 代码仍在 `server/`、`test/`、`web/` 中按分层组织，靠本表与目录名对应功能。
- 每次提交属于哪个功能，就在该功能目录的 `commit.md` 追加一行 commit message；跨功能的提交在每个被触碰的功能里各记一行。
- 功能粒度按主设计文档 §2.1 的 v1 功能清单；新增/拆分功能时要同步建目录与文档。

**状态口径**：`已完成` = 代码 + 测试 + 文档齐备；`需求已定` = prd/design 已就位、代码待实现。

## 一、已完成

| 功能 | 目录 | 计划 | 代码位置 |
|---|---|---|---|
| 工程基座与配置 | `foundation/` | 计划 1 | package.json、test/helpers.mjs、server/{errors,config,db}.mjs |
| 节点树与增删改（含 `defect` 类型） | `node-tree/` | 计划 1 | server/store.mjs（节点部分）|
| 属性系统 | `attributes/` | 计划 1 | server/store.mjs（属性部分）|
| 文档（Markdown 多份 + 需求文档集中管理/缺口对账） | `documents/` | 计划 1 | server/store.mjs（文档部分）+ `documentOverview`；三入口 + DocumentsView |
| 变更可见与审计（revision） | `revision/` | 计划 1 | server/store.mjs（revision / 审计）|
| commit 手工登记 | `commit-registry/` | 计划 1 建表 · 计划 2 入口 | server/store.mjs（commits 部分）|
| 三入口：HTTP API / CLI / MCP | `entrypoints/` | 计划 2 | server/{http,cli,mcp,index,ops}.mjs、bin/taskboard.js |
| 表格式展开树 + 右侧抽屉 + 文档区 | `tree-table-ui/` | 计划 3 | web/src/views/TreeView.vue、web/src/components/{NodeDrawer,DocPane}.vue |
| dsh-charge 需求同步导入 | `dsh-import/` | 计划 3 配套 | server/import-dsh.mjs |
| commit 在线预览（单 commit + 子树聚合，统一/分栏） | `diff-preview/` | 计划 4 | server/git.mjs、web/src/components/DiffPane.vue |
| 分支合并追踪（测试 / 预发 / 上线） | `branch-track/` | 计划 4 | server/git.mjs、SettingsView、NodeDrawer |
| commit 审查（审查状态 / 意见，三入口 1:1） | `commit-registry/` | 计划 4 增强 | server/store.mjs（commits review）+ NodeDrawer |
| 多 commit 合并 diff（MR 式净变更 + commit 明细） | `commit-registry/` | 计划 4 增强 | server/ops.mjs（getCombinedDiff）|
| agent 测试运行（qodercli 后台 / Qoder IDE 前台 ideMode） | `agent-run/` | — | server/agent.mjs |
| **agent 运行时管理**（运行时/会话/任务三层 + 消息流 + 续跑/重试/取消，对齐 multica） | `agent-runtime/` | — | server/{db,store,agent}.mjs、server/{http,cli,mcp}.mjs、idea-plugin AgentConsoleDialog |
| **Qoder 联动**（hook 注入 / MCP 读写 / 前台派单 / 选区自动捕获） | `qoder-integration/` | — | hooks/qoder-bridge.mjs、QoderOpener + 选区监听（插件）、MCP agent_run_* |
| **对照布局与面板显隐**（三栏铺排/☑开关/比例设置/节点树按钮行 + 三连踩坑） | `layout-panes/` | — | idea-plugin（TaskBoardPanel/LayoutPrefs/PrdOpener/DiffOpener） |
| **审批合并**（同意→开发分支合入子需求需求分支；已合入跳过/冲突拒绝；组级合入状态） | `merge-flow/` | — | server（git/ops/http merge）+ 插件「标记通过/合入状态」 |
| **Diff 行级评论**（diff 选中行留评 → task-board；节点/文件/行号/sha 绑定） | `diff-comments/` | — | server（comments 表/三入口）、插件「评论/评论列表」 |
| 网页 → IDEA 打开 diff（IDE 桥） | `ide-bridge/` | — | server/store.mjs（ide_requests）+ DiffPane/NodeDrawer |
| 重复检测与一键去重（+ 需求分支标注） | `duplicates/` | — | server/ops.mjs（getNodeDuplicates）+ NodeDrawer |
| **回归测试闭环**（AI 可回归测试用例 + 测试/验收报告 + 验收签收 + 提示词派单） | `regression-loop/` | — | server/{db,store,ops}.mjs（test_cases/test_reports/acceptance_signoffs）+ 三入口 test_* |
| **上线治理**（上线配置 / 上线 SQL / 上线检查清单 + agent 前置检查派单；就绪 = 必做项完成 **且** 检查用例 `pass`） | `release-governance/` | — | server/{db,store,ops}.mjs（release_items + 检查用例聚合）+ 三入口 release_* |
| **回归测试闭环**（AI 可回归测试用例 + 测试/验收报告 + 提示词派单） | `regression-loop/` | — | server/{db,store,ops}.mjs（test_cases/test_reports）+ 三入口 test_* |
| **上线治理**（上线配置 / 上线 SQL / 上线检查清单 + agent 前置检查派单） | `release-governance/` | — | server/{db,store,ops}.mjs（release_items）+ 三入口 release_* |
| **上线 SQL 风险审查**（只读静态扫描 kind=sql 上线项：DROP/TRUNCATE/无 WHERE 阻塞，DROP COLUMN/缺回滚提示） | `release-sql-audit/` | — | server/{config,store,ops}.mjs（buildReleaseSqlAudit / renderReleaseSqlAuditMd）+ 三入口 release_sql_audit |
| **需求就绪门禁**（需求内容 / 概要设计 / 可回归用例三条门禁 + 子树汇总，纯读聚合不落表） | `requirement-readiness/` | — | server/{config,store,ops}.mjs（buildRequirementReadiness）+ 三入口 readiness |
| **概要设计大纲 / 思维导图**（从需求树推导 mermaid 脑图 + 逐层小节，一键写入「概要设计」文档） | `design-outline/` | — | server/{store,ops}.mjs（buildDesignOutline / applyDesignOutline）+ 三入口 design outline/apply + NodeDrawer「概要设计」页签 |
| **需求思维导图**（树 → mermaid mindmap 只读投影 + 深度截断 + 三入口 1:1 + 抽屉「导图」页签） | `requirement-mindmap/` | — | server/{store,ops}.mjs（buildMindmap）+ 三入口 mindmap + web/src/components/MindmapPane.vue |
| **主链路集成收口**（5 条分支按依赖合入 + 需求→交付门禁端到端回归脚本 + 冲突修复） | `mainline-integration/` | — | scripts/e2e-mainline.mjs + test/e2e-mainline.test.mjs（npm run e2e:mainline） |
| **交付门禁**（需求就绪 / 测试验收+签收 / 上线治理的最终汇总，纯读聚合不落表） | `delivery-gate/` | — | server/{store,ops}.mjs（buildDeliveryGate）+ 三入口 delivery_gate + NodeDrawer「交付」页签 |
| **验收签收**（测试证据 + 业务结论 + 证据指纹失效） | `acceptance-signoff/` | — | server/{db,store,ops}.mjs（acceptance_signoffs）+ 三入口 acceptance_status/sign |
| **需求管理**（需求条目 / 受控状态流转 / 核心文档关联 + Web 需求管理页） | `requirement-management/` | — | server/{store,http,cli,mcp}.mjs（requirement_*）+ web/src/views/RequirementsView.vue |
| **图片上传**（文档粘贴 / 选择图片 → base64 JSON → `/uploads/<name>`，魔数与声明类型交叉校验） | `uploads/` | 计划 5 | server/uploads.mjs + server/{http,cli,mcp}.mjs（upload_image）+ DocPane Vditor upload.handler |
| **工作区准备**（工作单元登记仓库 → 建分支 + worktree → 返回开发提示词；清理需 confirm，未并分支保留） | `workspace-setup/` | 计划 4 | server/{git,store,ops,http,cli,mcp}.mjs（unit_repos / setupWorkspace / unit_*）|
| **代码检查**（已登记提交新增行的只读静态审查：冲突标记 / 私钥 / 硬编码凭据 / eval / 聚焦测试 / 调试遗留，danger 阻塞 + warn 提示） | `code-audit/` | — | server/{git,code-audit,ops}.mjs（commitAddedLines / getNodeCodeAudit）+ 三入口 code_audit + NodeDrawer「代码检查」页签 |
| **交付门禁**（需求就绪 / 测试验收 / 上线治理的最终汇总，纯读聚合不落表） | `delivery-gate/` | — | server/{store,ops}.mjs（buildDeliveryGate）+ 三入口 delivery_gate + NodeDrawer「交付」页签 |
| **并行派单**（回归用例 fan-out：每条用例一个独立 agent 任务，`maxParallel` 护栏） | `test-fanout/` | — | server/ops.mjs（runTestCases 的 fanout 分支）+ 三入口 test_run 的 `fanout`/`maxParallel` |
| **文档敏感信息扫描**（节点/子树文档只读凭据扫描；高危阻塞、证据强制脱敏、空态 ready=null） | `secret-scan/` | — | server/store.mjs（buildSecretScan）+ server/ops.mjs（renderSecretScanMd）+ 三入口 secret_scan |
| **交付证据快照**（冻结交付门禁完整依据 + 指纹，读取时核对 current / drifted，供验收与上线审计） | `delivery-snapshot/` | — | server/{db,store,http,cli,mcp,ops}.mjs（delivery_snapshots）+ NodeDrawer「交付」页 |

### 已实现但**不设独立目录**（语义并入上述目录，避免索引重复）

| 功能 | 并入 | 代码位置 |
|---|---|---|
| 缺陷登记 | `node-tree/`（类型与父子校验）| `nodes.type = 'defect'` |
| 属性定义管理页 | `tree-table-ui/` | web/src/views/AttrDefsView.vue |
| 设置页（GitLab / 端口 / 状态值域） | `tree-table-ui/` | web/src/views/SettingsView.vue |
| 仓库登记 | `tree-table-ui/` | server/store.mjs（repos 部分）+ 抽屉/设置页 |
| 给 AI 的用法 | `smoke-and-ai-docs/` | `AGENTS.md` |
| 接口示例 | `smoke-and-ai-docs/` | `docs/api.md` |
| 数据快照导出/导入（表集合由 schema 推导，新增表自动纳入） | `foundation/` | `scripts/{export,import}-snapshot.mjs` + `scripts/snapshot-tables.mjs`（`npm run snapshot:export/import`）|

## 二、需求已定，待实现（计划 4–5）

| 功能 | 目录 | 计划 | 代码位置（待建）|
|---|---|---|---|
| 代码集成（显式合并） | `merge-integration/` | 计划 4 | server/git.mjs、merges 表 |
| 冲突检测与处理 | `conflict-resolution/` | 计划 4 | server/git.mjs、web ConflictPane |
| MR 自动拉取 | `mr-sync/` | 计划 5 | server/gitlab.mjs、mrs 表 |
| 冒烟脚本 | `smoke-and-ai-docs/` | 计划 5 | scripts/smoke.mjs |

> 计划 4–5 的功能目录里已有 `prd.md`（需求 + 验收标准）与 `design.md`（设计要点 + 关联章节 + 注意事项），
> 代码实现前请先读该目录，并按 [`AGENTS.md`](../AGENTS.md) 的「文档维护规范」同步更新。

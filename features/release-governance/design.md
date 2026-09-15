# 功能设计：上线治理（上线配置 / 上线 SQL / 上线检查清单）

## 1. 模块职责

- `server/db.mjs`：新增 `release_items` 一张表（SCHEMA 对新库生效，`migrate()` 对老库幂等补表）。
- `server/store.mjs`：唯一读写核心。
  - 上线项：`createReleaseItem` / `listReleaseItems` / `getReleaseItem` / `upsertReleaseItem` / `updateReleaseItem` / `deleteReleaseItem` / `reorderReleaseItems`
  - 聚合：`buildReleaseChecklist`（按节点或子树汇总完成度、按类型分布、就绪结论、阻塞项）
- `server/ops.mjs`：跨 store 的编排，不绑定入口。
  - `runReleaseChecks`：选检查用例 + 拼上线清单 → `startAgentRun` 派单 → 开 running 报告；`dryRun` 走纯预演分支。
  - `composeReleaseCheckPrompt`：把上线清单与检查用例拼成给 agent 的上线前置检查指令。
  - `renderReleaseChecklistMd`：聚合结果 → markdown 上线单。
- `server/http.mjs` / `cli.mjs` / `mcp.mjs`：三入口 1:1 暴露（只做参数装配 + 错误映射）。

## 2. 关键规则

**R1 为什么复用 `test_cases` 的 kind 扩展轴**：回归测试闭环已经把 `kind` 设计为统一扩展轴，
`code_check` / `biz_check` / `release_check` 三个值在表约束里已占位。
所以「上线检查 / 代码检查 / 业务检查」的**执行**直接复用 `runReleaseChecks` 从 `test_cases` 里挑这三类用例，
不改 `test_cases` 表结构；`release_items` 只补**结构化的上线项**（配置 / SQL / 检查项 + 回滚 + 状态）。

**R2 上线项挂任意节点**：与测试用例同理——需求、子需求、任务组、子任务都可能各自需要上线动作。
统一 `node_id` 挂载，避免为每类节点各建一张表。

**R3 upsert 幂等**：AI 反复调用 `release_item_upsert` 安全（与 `doc_upsert` / `test_case_upsert` 一致）；
按 `(node_id, name)` 唯一，`created` 标记让调用方知道是新建还是覆盖。

**R4 就绪口径**：只有**必做项**（`required=1`）参与就绪判定，且必须落在 `done` / `skipped`；
可选未完成不影响 `ready`。空态（既无必做项也无检查用例）时 `ready=null`（与验收报告 `passRate=null` 同口径，避免「没有项 = 未就绪」误判）。

**就绪必须纳入检查用例**：`ready` 不只取决于 `release_items`。登记的 `code_check` / `biz_check` / `release_check` 用例
若最近一次不是 `pass`（含 `not_run` / `running` / `fail` / `blocked` / `error` / `cancelled`），同样阻塞上线——
否则会出现「必做项全 done、代码检查没跑」的假绿灯。只取每用例**最近一条**报告，历史 pass 不掩盖后来的 fail；
停用用例不阻塞（既不会被派单，也不该拦住上线）。就绪值域由 `store.RELEASE_CHECK_CASE_KINDS` 单点定义，
与 `runReleaseChecks` 派单共用，避免「清单纳入」与「派单纳入」两处口径分叉。
输出 `blockers`（必做项）与 `caseBlockers`（检查用例，带 `latestStatus` / `latestReportId`），
并补 `totals.checkCases` / `checkPass` / `checkPending` / `checkRunning` 与 `byCaseKind` 分桶。

**Web 面板**：抽屉「上线就绪」页签（`web/src/components/ReleasePane.vue` + `web/src/release.js`）展示结论、KPI、
上线项 CRUD/行内改状态、检查用例最近结果与两类阻塞项，并支持「执行上线检查」先 `dryRun` 预演再派单。
`blocked` 单列在 `totals.blocked` 且必然出现在 `blockers` 里。

**R4.1 `done` 与 `skipped` 分开计数**：两者对就绪的效力相同（都算不必再处理），但含义不同。
`totals` 同时给 `done` 与 `skipped`，Markdown 摘要写「完成：N · 跳过：M」——
只报 `done` 会让「必做项全是 skipped」显示成「已完成：0」，看起来像没做完（独立测试发现的展示误读）。

**R4.2 `upsert` 的覆盖 vs 保留**：**新建**时未提供的字段取默认值（config / '' / null / pending / 必做）；
**已存在**时只更新显式传入的字段，其余保持原样。否则「只想改 content」会把 `rollback` / `status` 静默清掉。
需要显式清空就传空值（`rollback: null` / `content: ''`）。

**R4.3 补默认值是 store 的职责，不是入口的**：三个入口（HTTP / CLI / MCP）必须把**调用方真正传了的字段**
原样交给 store，未传的保持 `undefined`；**入口不得**先补成 `kind||'config'`、`rollback??null`、`status||'pending'`、
`required===undefined?1:required` 之类的默认值再交给 store——那样 store 看到的就永远是「显式传入」，
已存在项的 `rollback` / `status` / `required` 会被默认值静默回退。
新建时的默认值由 `createReleaseItem` 的形参默认值兜底，因此入口一律透传即可同时满足两段语义。
（背景：5c38748 上 store / HTTP 正确，但 CLI 与 MCP 在参数装配处补了默认值，独立测试发现三入口不一致。）

**R5 执行与清单解耦**：`runReleaseChecks` 只负责「派单 + 开报告」，不阻塞等待 agent 结果；
agent 任务结束后由前台执行者（或收尾钩子）用 `test_report_finish` 逐条回写 pass/fail，与回归测试闭环完全一致。

**R5.1 自动收尾**：任务落终态时由 `finalizeReportsForRun` 自动收尾关联 `running` 报告（详见
`../regression-loop/design.md` R5.1）；CLI 非 dry-run 会等到终态再退出（`--no-wait` 可退回只派单）。

**R5.2 scope 口径**：`release_checklist` 与 `release check` 共用 `scope=self|subtree`——
`subtree` 会把子树的上线项与检查用例一起纳入。`self` 下若本节点为空但子树有上线项，
报错信息会明确提示改用 `scope=subtree`，避免「子树有上线项却没进检查」的误解。
值域由 `store.normalizeScope` 单点校验：缺省取 `self`，非法值（含 `Subtree` / 空串）返回
`VALIDATION_FAILED`；**不做静默降级**，否则「子树仍有未完成必做上线项」会被判成就绪。

## 3. 踩坑 / 约束

- `runReleaseChecks` 的第一参是 **store**，不是 node；三入口装配时别传错（与 `runTestCases` 同一个坑）。
- 只登记上线项（没有 `code_check` / `biz_check` / `release_check` 用例）也能 `dryRun`——
  这时 `cases` 为空、`items` 非空，提示词只含上线清单；两条都为空才报 `VALIDATION_FAILED`。
- 真派单同样需要节点子树内有带本地路径的登记仓库；纯清单管理（upsert / checklist / dryRun）不依赖仓库。
- **HTTP 状态映射**：`TEST_CASE_NAME_EXISTS` / `RELEASE_ITEM_NAME_EXISTS` 必须登记在 `STATUS_BY_CODE` 里映射到 409；
  漏登记会走默认 500，与设计文档和 AI 自纠预期不符（本轮顺手修了 `TEST_CASE_NAME_EXISTS` 这个既有缺陷）。

## 4. 关联章节

- 数据模型：`docs/design/02-data-model.md` §4.15
- 接口表：`docs/design/04-api.md`「上线治理」段
- 接口示例：`docs/api.md`
- 测试策略：`docs/design/08-testing.md`（单测分组：`test/release-item.test.mjs`）
- 前置功能：`../regression-loop/`（kind 扩展轴与报告模型）

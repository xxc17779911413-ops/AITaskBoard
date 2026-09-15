# 功能设计：业务检查门禁（业务可验收性的只读判定）

## 1. 模块职责

- `server/store.mjs`：唯一读写核心，新增 `buildBusinessGate(nodeId, { scope })`——
  选缺陷与 `biz_check` 用例 → 取每用例最近报告 → 汇总顶层三态结论。**纯读，不 bump revision**。
- `server/ops.mjs`：`renderBusinessGateMd(gate)` 渲染 markdown；并把 `business_gate` 登记进 `TOOLS`。
- `server/http.mjs` / `cli.mjs` / `mcp.mjs`：三入口 1:1 暴露（只做参数装配 + 错误映射）。
- `web/src/components/NodeDrawer.vue`：节点抽屉「业务检查」页签（self / subtree 切换 + 缺陷与用例表）。

## 2. 关键规则

**R1 为什么从既有数据推导而不是新建表**：业务可验收性是**结论**，不是新的业务数据。
缺陷已挂在 `nodes`（`type='defect'`），业务检查用例已挂在 `test_cases`（`kind='biz_check'`），
结论是从这两份数据推导出来的；落表会产生第二份真相，还要额外处理「缺陷关了 / 用例重跑后结论要不要失效」。
因此与 `acceptance_report` / `readiness` / `release_checklist` / 推送门禁同一条「只读聚合」原则
（决策 25 / 29 / 36）。

**R2 为什么缺陷终态只有 `done` / `cancelled`**：这两者是 `config.status.allowed.defect` 里唯一的终止状态
（见 `docs/design/02-data-model.md` §4.14）。`testing`（提测中）意味着缺陷修复待验证，仍属未关闭——
把它算作关闭会让「修了但没验」的缺陷直接放行，是业务侧最典型的假绿灯。

**R3 为什么只认最近一次报告**：一次执行 = 一行 `test_reports`。若按「曾经 pass 过」判定，
后来回归出的 `fail` 会被历史 `pass` 掩盖。取每用例 `id DESC` 的第一条（即最近一条）与
`buildAcceptanceReport` / `buildReleaseChecklist` 完全同源。

**R3.1 报告 kind 必须与用例 kind 一致（独立验收发现的假绿）**：`test_reports.kind` 不是自由标签，
它记录「这份结论属于哪一类用例」。原实现只在 `createTestReport` 校验 `caseId` 同节点与 `runId` 存在，
既不看报告的 `kind`，聚合时也按 `caseId` 直接取最近报告——于是 `biz_check` 用例挂上一条
`regression` 的 `pass` 报告即可让业务检查门禁 `ready=true`（独立验收实测）。修法是**写读两侧同时收窄**：

- **写入侧**：未显式传 `kind` 时直接沿用所挂用例的 `kind`（不再默认 `regression`，避免「少传一个字段」
  就踩进同一个坑）；显式传了就必须与用例 `kind` 相同，否则 `VALIDATION_FAILED` 拒绝入库。
  只有无 `caseId`（临时跑一次 / 用例已删除）时才回落到默认 `regression`。
- **读取侧**：`latestReportByCase` 只把 `report.kind === case.kind` 的报告认作该用例的结论。
  这一层不是冗余——它保护**已经存在**的老库脏数据（写入侧校验对历史行无效），
  也让 `buildBusinessGate` 与 `buildAcceptanceReport` 共用同一份口径，不会一个说通过、另一个说未过。

两层都不可省：只做写入侧会让历史脏数据继续假绿；只做读取侧则新写入仍可继续生产脏数据。

**R4 为什么 `running` 与 `not_run` 都阻塞**：`running` 表示已派单但还没回写结论，
`not_run` 表示从未执行——两者都**没有拿到业务通过证据**。把它们当通过等于「没验就放行」，
与交付门禁「`not_pushed` / `unknown` 都不冒充通过」、验收报告「`running` / `notRun` 不计入分母」同一条纪律。

**R5 空态 `ready=null`**：范围内既没有缺陷、也没有启用中的 `biz_check` 用例时，没有可判定对象。
返回 `null` 而非 `false`，与验收报告 `passRate=null`、上线清单「无必做项 `ready=null`」、
就绪门禁「无待判定需求 `ready=null`」同口径：**不知道 ≠ 没通过**。
调用方拿到 `null` 应提示「没有可判定的业务检查内容」。

**R6 `blockers` 用 `kind` 区分两类**：`open_defect` 与 `unpassed_case` 的修复动作完全不同
（关缺陷 vs 跑用例），压成一个笼统的「阻塞」会让调用方不知道该做什么。
与决策 37「分类值域是契约，不能把多种失败压成一个值」同一条纪律。

**R7 只读语义**：门禁不修改任何数据，因此**不产生 revision**——AI 可以高频轮询做看板，
而不该因此制造变更噪声（否则前端 `/api/revision` 轮询会被自己触发）。

**R8 `scope` / `format` 单点校验**：入口把原始值透传给 `store.normalizeScope` /
`store.normalizeFormat`，不得先做 `scope === 'subtree' ? … : 'self'`——
否则 `scope=Subtree` 会被吞成 `self`，让「子树里有未关闭缺陷」被汇报成 `ready=true`（放行门禁假绿，见决策 31 / 35）。

## 3. 判定口径一览

| 来源 | 通过条件 | 阻塞条件 |
|---|---|---|
| 缺陷（`nodes.type='defect'`） | `status` ∈ `done` / `cancelled` | `status` ∈ `todo` / `doing` / `testing` |
| 业务检查用例（`test_cases.kind='biz_check'` 且 `enabled=1`） | 最近一次**且 `report.kind='biz_check'`** 的报告 `status='pass'` | 最近一次为 `fail` / `blocked` / `error` / `cancelled` / `running`，或从未执行（`not_run`），或该用例只有 kind 不一致的报告（视同 `not_run`） |

空态：范围内无缺陷且无启用中的 `biz_check` 用例 → `ready=null`。

## 4. 踩坑 / 约束

- 缺陷是**节点**，与用例不在同一张表：`defects` 里用 `rawNode` 行（含 `status`），
  `cases` 里用 `testCaseVO`（含 `expectation`），两者不要互相套用字段。
- 停用用例（`enabled=0`）必须显式排除：SQL 里带 `AND enabled = 1`，
  这与 `buildAcceptanceReport` 的过滤一致；漏掉会让「停用的历史用例」永远以 `not_run` 拦住业务验收。
- 报告与用例的 `kind` 一致性校验在 `assertReportRefs` 返回的用例行上完成（复用同一次查询，不额外查库）；
  读取侧走 `latestReportByCase` 单点实现，`buildBusinessGate` 与 `buildAcceptanceReport` 共用，
  避免两处各写一份过滤条件后再次跑偏。
- `scope=subtree` 走 `subtreeIds`，与其它聚合接口同一份口径；`self` 只审本节点。
- markdown 渲染必须转义表格单元格里的 `|` 与换行（缺陷名 / 用例名可能含这些字符），
  否则会多分列或截断表格（与 `renderDeliveryGateMd.cell()` 同款处理）。
- 本门禁**暂不并入** `delivery_gate`：那会改变其 `totals.sources` 既有契约与断言，属后续显式决策。

## 5. 关联章节

- 接口表：`docs/design/04-api.md`「业务检查门禁」段
- 接口示例：`docs/api.md`
- 测试策略：`docs/design/08-testing.md`（单测分组：`test/business-gate*.test.mjs`）
- 决策：`docs/design/09-decisions.md` 决策 42（只读聚合推导，不落表）
- 相邻功能：`../regression-loop/`（`test_cases` / `test_reports` 模型）、
  `../release-governance/`（`biz_check` 用例的登记与派单）、`../delivery-gate/`（交付结论）

# 功能：业务检查门禁（业务可验收性的只读判定）

- 代码：`server/store.mjs`（`buildBusinessGate`）、`server/ops.mjs`（`renderBusinessGateMd`）
- 入口：HTTP（`GET /api/nodes/:id/business-gate`）· CLI（`business gate <ref>`）· MCP（`business_gate`）· Web（节点抽屉「业务检查」页签）
- 主设计文档：`../../docs/design/04-api.md`；相邻功能：`../regression-loop/`（`test_cases.kind` 扩展轴）、
  `../release-governance/`（`biz_check` 用例的登记与派单）、`../delivery-gate/`（交付结论）

## 1. 目标

TaskBoard 的主链路已经能回答「需求备齐没有」（就绪门禁）、「测试跑没跑通」（验收报告）、
「上线动作能不能执行」（上线清单），以及「登记的提交到没到远程」（推送门禁）。
但**业务侧到底能不能验收**始终没有一个确定结论：缺陷挂在树里没有聚合成阻塞项，
`biz_check` 用例的结论只被上线清单当作「上线证据之一」顺带看一眼，没有独立入口。

本功能补上这条独立判定：把节点（含可选子树）的**未关闭缺陷**与**启用中的 `biz_check` 用例最近结论**
收敛成一个三态结论，让「业务检查」从一句口头约定变成可查询、可回归、可贴进 issue 的确定证据。

## 2. 需求点

- R1 判定对象是节点（含可选子树）内既有数据，**不新增表、不改 `test_cases` / `test_reports` 结构**：
  - 缺陷：`nodes.type = 'defect'`；
  - 业务检查用例：启用中的 `test_cases.kind = 'biz_check'`。
- R2 缺陷口径：`status` 为 `done` / `cancelled` 视为**已关闭**，其余（`todo` / `doing` / `testing`）都是**未关闭阻塞项**。
- R3 用例口径：只算**启用中**的 `biz_check` 用例（停用的既不会被派单，也不该阻塞业务验收）；
  每个用例只认**最近一次**报告结论，避免历史 `pass` 掩盖后来的 `fail`。
- R3.1 **报告与用例的 kind 必须一致**：报告的 `kind` 是「这份结论属于哪条用例」的一致性凭据。
  写入侧 `createTestReport` 未传 `kind` 时沿用所挂用例的 `kind`（不再默认 `regression`），
  显式传了就必须与用例 `kind` 相同，错配一律 `VALIDATION_FAILED` 拒绝入库；
  读取侧 `buildBusinessGate` / `buildAcceptanceReport` 都只采信 `report.kind === case.kind` 的报告，
  使老库里已存在的不一致历史行也不再被信任（否则一条 `regression` 的 `pass` 会把业务检查判成通过——假绿）。
- R4 只有 `pass` 算通过：`running`（已派单未回写）与 `not_run`（从未执行）都阻塞——
  与验收报告 / 上线清单 / 交付门禁同源口径。
- R5 顶层三态：有任一阻塞项 → `ready=false`；全部通过 → `ready=true`；
  范围内既无缺陷、也无启用中的 `biz_check` 用例 → `ready=null`（没有可判定对象，不伪造成通过）。
- R6 输出 `defects` / `cases` 明细与 `blockers`（区分 `open_defect` 与 `unpassed_case` 两类）
  + `totals` 分桶，并支持 `format=md` 直接贴进 issue / 上线单。
- R7 只读聚合：**不写库、不动 revision**（与 `acceptance_report` / `readiness` / `release_checklist` / `delivery_gate` 同一条原则）。
- R8 `scope` / `format` 复用 `store.normalizeScope` / `store.normalizeFormat`，非法值一律 `VALIDATION_FAILED`，三入口一致。

## 3. 非目标（首版）

- 不做缺陷严重程度 / 优先级加权（首版所有未关闭缺陷一视同仁；权重留给属性系统扩展）；
- 不自动执行业务检查（执行仍走既有 agent 派单链路，即 `release check` / `test run`）；
- 不并入 `delivery_gate` 作为第五个来源（会改 `totals.sources` 契约，属后续显式决策）；
- 不做业务检查用例的覆盖率判定（只看已登记用例的结论，不评判「该不该有更多用例」）。

## 4. 验收标准

- `test/business-gate.test.mjs`：空态 `ready=null`；未关闭缺陷阻塞 / `cancelled` 与 `done` 关闭；
  用例 `not_run` / `running` / `fail` 阻塞、`pass` 放行；历史 `pass` 不掩盖后来的 `fail`；
  停用与其它 kind 不参与；`scope=self` 与 `subtree` 的纳入差异；非法 `scope` → `VALIDATION_FAILED`；
  **纯读不产生 revision**；markdown 渲染（含表格单元格 `|` 转义）；
  **报告 kind 与用例 kind 不一致的假绿回归**（写入侧拒绝 + 省略 kind 时沿用用例 kind + 读取侧忽略历史脏行）。
- `test/business-gate-entrypoints.test.mjs`：CLI 真实子进程与 store 逐字段一致、`--format md`、非法 `--scope` 非零退出；
  MCP 真实协议与 store 一致、非法 `scope` 返回 `isError + VALIDATION_FAILED`（不泄漏 SDK `-32602`）。
- `test/http.test.mjs`：全链路（未关闭缺陷 + 未跑用例 → 阻塞 → 关闭并跑通 → 放行）、空态、md、非法 `scope` 400。
- `npm test` 全绿；三入口 1:1；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/design/08-testing.md`
  + `docs/design/09-decisions.md` + `docs/api.md` + `features/README.md`）。

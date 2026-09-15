# 功能：验收结论（按需求 / 版本）

- 代码：`server/store.mjs`（`buildAcceptanceConclusion`）、`server/ops.mjs`（`renderAcceptanceConclusionMd`）、`server/{http,cli,mcp}.mjs`、`web/src/components/RegressionPane.vue`
- 入口：HTTP（`/api/nodes/:id/acceptance-conclusion`）· CLI（`acceptance conclusion <ref>`）· MCP（`acceptance_conclusion`）
- 主设计文档：`../../docs/design/04-api.md`；相邻功能：`../regression-loop/`、`../requirement-readiness/`、`../release-governance/`

## 1. 目标

`acceptance-report` 只回答「测试过没过」，但一次验收还要看**文档缺口**（需求内容 / 概要设计）。
本功能把两段既有结论收敛成一句可交付判断，并按**需求 / 版本**给出逐条结论，让「这次验收能不能过」有唯一入口。

## 2. 需求点

- R1 按需求生成结论：复用 `buildAcceptanceReport`（逐用例最近结果）与 `buildRequirementReadiness`（逐需求文档门禁），不新增表、不写库、不 bump revision。
- R2 逐需求结论三态：
  - `pass`：所有启用中用例最近一次均为 `pass`，且文档门禁全过；
  - `fail`：有用例但存在未通过 / 未执行 / 执行中，或文档门禁未过；
  - `not_applicable`：该需求没有任何可验收证据。
- R3 按版本：节点的「版本」属性（attribute key = `version`）作为分组轴；`version` 参数过滤后只判定匹配需求。
- R4 整体结论三态：`accepted` / `rejected` / `unknown`；`ready` 对 `unknown` 返回 `null`，避免把空态伪造成绿灯。
- R5 阻塞项展平到需求级：测试阻塞（`source=test`）与文档阻塞（`source=document`）分别标注。
- R6 `scope=self|subtree` 与 `format=json|md` 均枚举校验；非法值 `VALIDATION_FAILED`（三入口一致）。

## 3. 非目标（首版）

- 不做人工签核 / 审批流（签核另由 `acceptance-signoff` 承载）；
- 不新增数据表：结论是既有数据的只读聚合；
- 不替代 `acceptance-report` / `readiness` 的明细接口。

## 4. 验收标准

- `test/acceptance-conclusion.test.mjs`：空态 `unknown`；文档就绪但测试未跑 → `fail`（原因测试）；测试通过但缺概要设计 → `fail`（原因文档）；两者齐 → `accepted`；按版本过滤与过滤后空态；`scope` 联动；纯读不产生 revision；非法 `scope` 拒绝。
- `test/acceptance-release-entrypoints.test.mjs`：store / HTTP / CLI / MCP 逐字段一致；`format=md` 可导出；非法 `scope` HTTP 400。
- `test/release-view.test.mjs`：上线就绪展示口径（就绪标签、KPI、阻塞项计数）。
- `npm test` 全绿；三入口 1:1；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/design/06-ui.md` + `features/README.md`）。

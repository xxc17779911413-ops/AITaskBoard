# 功能：结构探索（需求树 + 文档/用例/验收状态）

- 代码：`server/store.mjs`（`buildStructureGraph`）、`server/ops.mjs`（`renderStructureGraphMd` + `TOOLS` 登记）、`server/{http,cli,mcp}.mjs`、`web/src/views/StructureView.vue` + `web/src/structure.js`
- 入口：HTTP（`GET /api/nodes/:id/structure-graph`）· CLI（`structure graph <ref>`）· MCP（`structure_graph`）· Web（顶栏「结构探索」）
- 主设计文档：`../../docs/design/04-api.md`、`../../docs/design/06-ui.md`

## 1. 目标

任务树只能逐层看结构，看不出「哪块没写文档、哪块测试没跑、哪块没验收」。本功能在既有节点树上做一层
**只读状态图谱**：每个节点带文档缺口、回归用例数 / 最近结论、需求就绪与门禁阻塞，支持基础筛选与节点跳转。
复用现有节点 / 文档 / 用例 / 门禁模型，不新增表、不扩展成协作画布。

## 2. 需求点

- R1 只读投影：复用节点树 + 文档 + 用例 + `buildRequirementReadiness`，不写库、不 bump revision。
- R2 范围：`scope=self` 只画本节点，`scope=subtree` 画整棵子树（与 readiness / acceptance / delivery-gate 同一份 scope 口径）。
- R3 状态叠加（每节点）：`documentCount` / `documentGaps` / `hasGap`、`caseCount` / `casePass` / `caseFail` / `caseRunning` / `caseNotRun` / `caseStatus`、`ready` / `gateBlockers`。
  - 文档缺口只对 `requirement` / `subreq` 判定（需求内容 / 概要设计未填）。
  - 用例最近结论按**最严重优先**：`fail > running > not_run > pass`；无用例为 `null`（不伪造成通过）。
- R4 基础筛选（全部可选，非法值一律 `VALIDATION_FAILED`）：`type`（节点类型）、`status`（需求状态）、`ready`（true/false）、`hasGap`（true/false）、`caseStatus`（pass/fail/not_run/running）、`q`（名称 / 路径子串）。
- R5 筛选只影响展示：边必须两端都被保留（无悬空连接）；`totals.total` 记录筛选前节点数，`totals.nodes` 记筛选后。
- R6 三入口 1:1 + `format=md` 可贴 issue；Web 顶栏「结构探索」提供筛选、KPI、树形缩进列表与「跳转」（打开节点抽屉）。

## 3. 非目标（首版）

- 不做拖拽编辑（结构真相仍在节点树；改结构走节点操作）。
- 不做自由布局 / 富样式画布，只做只读投影 + 筛选。
- 不替代既有 `mindmap`（纯树 mermaid 文本）与 `acceptance_conclusion`（按版本验收结论）接口；本功能是它们之上的状态探索视图。

## 4. 验收标准

- `test/structure-graph.test.mjs`：`self` / `subtree` 节点·边·深度；状态叠加（缺口 / 用例最近结论 / 就绪）；用例状态最严重优先；六类筛选；筛选后边两端保留；非法值拒绝；纯读不产生 revision。
- `test/structure-graph-entrypoints.test.mjs`：store / HTTP / CLI / MCP 逐字段一致；`format=md` 导出；非法 `scope` / `type` / `status` / `ready` / `hasGap` / `caseStatus` / `format` 均 `VALIDATION_FAILED`（MCP 为 `isError`，不泄漏 `-32602`）。
- `test/structure-view.test.mjs`：展示口径（值域、就绪标签 null→「—」、文档 / 用例文案、筛选生效判定、KPI）。
- `npm test` 全绿；`npm run build` 通过；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/design/06-ui.md` + `features/README.md`）。

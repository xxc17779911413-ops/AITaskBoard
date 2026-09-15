# 设计：结构探索（需求树 + 文档/用例/验收状态）

## 1. 模块职责

- `server/store.mjs`：`buildStructureGraph(nodeId, { scope, type, status, ready, hasGap, caseStatus, q })` 是唯一聚合点。
  - 遍历节点树（复用 `nodeVO` / `listDocuments` / `listTestCases` / `buildRequirementReadiness`）；
  - 不新增表、不写库、不 bump revision。
- `server/ops.mjs`：`renderStructureGraphMd` 渲染成可贴 issue 的 markdown 缩进表。
- `server/{http,cli,mcp}.mjs`：三入口 1:1，只做参数装配与值域校验。
- `web/src/views/StructureView.vue` + `web/src/structure.js`：顶栏「结构探索」页面；纯展示函数可单测。

## 2. 关键规则

**R1 为什么在 store 聚合**：结构与状态都是既有数据的投影，落表会产生第二份真相；与
`acceptance_report` / `readiness` / `delivery_gate` 同一条「结论不落库」原则。

**R2 用例最近结论的最严重优先**：一个节点可能挂多条用例，`caseStatus` 取最严重的一档
（`fail > running > not_run > pass`），避免「有 1 条失败仍显示通过」。无用例为 `null`——既不是通过也不是失败。

**R3 文档缺口只判需求两层**：缺口 = 需求内容 / 概要设计文档缺失或正文空白（与 readiness 的
`docFilled` 同口径）。项目 / 任务组 / 子任务只报 `documentCount`。

**R4 就绪沿用门禁口径**：`ready` 直接取 `buildRequirementReadiness(...).units[0].ready`，
即「需求内容 + 概要设计 + 有可回归用例」三条门禁；非需求类型为 `null`（不适用）。
注意这是**能否进入回归测试**的口径，不是「用例是否通过」——用例通过与否看 `caseStatus`。

**R5 筛选只影响展示**：`totals.total` 是筛选前节点数，`totals.nodes` 是筛选后；`edges` 只保留两端都在
结果集里的连接，避免悬空。非法筛选值一律 `VALIDATION_FAILED`（不静默降级），与 `scope` / `format` 同纪律。

**R6 与既有导图的关系**：`mindmap`（xpx-126）是纯树 mermaid 文本投影，只有 `name`；
本功能在其上加状态叠加与筛选，不重复实现 mermaid 文本。

## 3. 关联章节

- 接口表：`docs/design/04-api.md`「结构探索」段
- UI：`docs/design/06-ui.md`
- 相邻功能：`features/requirement-readiness/`、`features/regression-loop/`、`features/acceptance-conclusion/`、`features/documents/`

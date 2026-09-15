# 功能：研发主线思维导图（workflow-map）

- 代码：`server/store.mjs`（`buildWorkflowMap`）、`server/ops.mjs`（`renderWorkflowMapMd`）、`server/{http,cli,mcp}.mjs`、`web/src/components/WorkflowMapPane.vue`、既有 `release_*` / `test_*` 写接口
- 入口：HTTP（`/api/nodes/:id/workflow-map`）· CLI（`workflow map <ref>`）· MCP（`workflow_map`）
- 相邻功能：`../requirement-readiness/`、`../documents/`、`../regression-loop/`、`../release-governance/`、`../delivery-gate/`

## 1. 目标

TaskBoard 已有需求文档、概要设计、AI 可回归测试、测试报告、验收报告、上线配置 / SQL / 检查等能力，但它们分散在线性页签与多个接口中。使用者能看到单点结论，却不容易回答：

- 这条需求当前卡在需求 / 设计 / 测试 / 验收 / 上线中的哪一段？
- 同一个项目下多条需求分别在哪些阶段有缺口？
- 上线配置、上线 SQL、上线检查、代码检查、业务检查是否已经被纳入同一条研发主线？

本功能提供一张**只读的研发主线思维导图**，以节点树为骨架，把既有数据投影成阶段与分支，让整条主线在一屏内可见。

## 2. 需求点

- R1 图挂在任意节点上；`scope=self` 只投影本节点，`scope=subtree` 纳入子树内所有 `requirement` / `subreq`。
- R2 主线阶段固定为：需求管理、概要设计、文档管理、思维导图、AI 可回归测试、测试报告、验收报告。
- R3 上线阶段固定为：上线配置、上线 SQL、上线检查、代码检查、业务检查。
- R4 每个阶段下按需求单元生成分支节点；分支状态使用四态：
  - `pass`：已有证据且结论通过；
  - `fail`：已有数据但未通过 / 有必做项未完成 / 门禁未满足；
  - `pending`：正在执行或等待结论；
  - `empty`：尚未登记该项，不代表通过。
- R5 需求管理 / 概要设计复用需求就绪门禁口径；文档管理统计文档数量与已填写数量；AI 可回归测试统计启用中的回归 / 验收用例。
- R6 测试报告读取该节点的报告；验收报告复用 `buildAcceptanceReport` 的口径，`running` / `notRun` 不视为通过。
- R7 上线配置 / 上线 SQL / 上线检查复用 `release_items`；代码检查 / 业务检查 / 上线检查用例复用 `test_cases.kind` 与最新报告状态。
- R8 返回 `stages`、`units`、`nodes`、`edges`、`totals`，同时给出可直接渲染的图结构；支持 `format=md` 输出摘要与待关注分支。
- R9 Web 抽屉新增「主线」页签：阶段节点与需求分支节点按状态着色，支持切换 `self` / `subtree`，点击节点查看依据，点击需求分支可定位节点。
- R10 纯读聚合：不写库、不落表、不改变 `revision`。
- R11 上线治理交互：图本身始终只读；右侧证据面板可显式触发既有写接口——
  - 上线配置 / 上线 SQL / 上线检查项：回写 `status`；
  - 代码检查 / 业务检查 / 上线检查用例：dry-run 后派单，并按最近报告回写 `pass` / `fail` / `blocked`；
  - 每次写回完成后重新读取图；`running` 仍为 `pending`，`empty` 仍不为通过。

## 3. 非目标（首版）

- 不新增数据表；
- 不替代需求就绪、验收报告、上线清单、交付门禁的明细接口；
- 不自动修复缺口，只展示证据与状态；
- 不做手工拖拽编辑图结构或持久化布局。

## 4. 验收标准

- `test/workflow-map.test.mjs`：阶段投影、四态区分、`scope=subtree` 多需求单元、非法 `scope` 拒绝、纯读不产生 revision、上线写引用、上线项与检查报告回写后状态翻转、D1 裸项目/空文档、D3 逐检查用例聚合、D4 `release_check` 上线项引用、markdown 渲染、能力清单登记。
- `test/format-validation.test.mjs`：D2 三入口 `format` 值域一致（HTTP 400 `VALIDATION_FAILED` / CLI 非零 / MCP `isError`）与纯读 revision 不变。
- `test/http.test.mjs`：HTTP 全链路（需求资料 → 用例 → 报告 → 上线项）与 `format=md`。
- `npm test` 全绿；三入口 1:1；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/api.md`
  + `docs/design/06-ui.md` + `docs/design/08-testing.md` + `features/README.md`）。

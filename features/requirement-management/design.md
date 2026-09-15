# 功能设计：需求管理

## 1. 模块职责

- `server/store.mjs`：新增需求专属读取与写入核心：
  - `listRequirements({ projectId, status })`
  - `requirementSummary({ projectId })`
  - `createRequirement({ projectId, name, attrs, actor })`
  - `transitionRequirement(nodeId, { status, actor })`
  - `REQUIREMENT_TRANSITIONS` 作为状态机单一事实来源。
- `server/http.mjs`：新增 `/api/requirements` 列表 / 创建与 `/api/requirements/:id/transition`，只做参数装配。
- `server/cli.mjs`：`requirement list|create|transition`。
- `server/mcp.mjs`：`requirement_list` / `requirement_create` / `requirement_transition`，业务错误走 `mcpValidate`。
- `web/src/views/RequirementsView.vue`：需求列表、KPI、创建弹窗、状态按钮，以及复用 `DocPane` 的文档抽屉。

## 2. 关键规则

**R1 不建新表**：需求本身就是 `nodes.type = 'requirement'`，文档就是 `documents`。
新增专属 API 只是为了把多条通用操作收敛成一条业务路径，避免 Web / AI 各自拼接步骤。

**R2 创建即关联**：保证下沉到通用 `createNode`：只要 `type=requirement`，无论来自专属创建、
通用 `POST /api/nodes`、`node_upsert` 还是 `batch.node.create`，都会按配置的
`readiness.requirementDoc` / `readiness.designDoc` 在同一组合写入里 upsert 两份空文档。
这样列表永远不会出现「像需求但没有文档槽位」的条目。
文档名沿用 `config.readiness`，团队改「详细设计」等命名时无需改本功能。

**R3 状态机在 store 强制且只有一套事实来源**：`REQUIREMENT_TRANSITIONS` 定义 workflow 图，
`config.status.allowed.requirement` 只能是该图的**子集开关**，不能引入图外状态。store 启动时：
若白名单包含图外状态，或缺少起始状态 `todo`，直接 `VALIDATION_FAILED`；否则按白名单对图做交集，
`assertRequirementStatus` / `canTransitionRequirement` / `canTransitionTo` / `requirementSummary`
全部使用这份有效状态集。`createNode` 只允许需求以 `todo` 起始，`updateNode` / `transitionRequirement`
统一复用该图；允许 `cancelled → todo` 是刻意保留的恢复通道，但 `done → *` 为空。
收窄后的 workflow 还必须满足：`done` 从 `todo` 可达，且所有非终态至少保留一条出边；否则启动期
`VALIDATION_FAILED`，避免产生永远无法完成的需求。

**R4 文档「关联」与「已填写」分开**：`docState` 同时返回 `linked` 与 `filled`。
创建需求会自动产生空白文档，如果只报关联状态，列表会把空壳需求误报成完整；
因此 KPI 的缺口统计看 `filled`，标签文案仍区分「未关联 / 空白 / 已填写」。

**R5 就绪结论复用现有门禁**：列表里的 `readiness` 直接调用 `buildRequirementReadiness(..., { scope: 'self' })`，
不在新视图里复制一套判断，保证需求管理页和 readiness / delivery-gate 的口径一致。

**R6 筛选必须同时作用于 items 与 summary**：HTTP 的 `status` 会同时透传给
`listRequirements` 与 `requirementSummary`，避免「表格只有 doing、KPI 却算全项目」的口径分裂。
非法 `projectId`（非数字 / 空串）显式 `VALIDATION_FAILED`，不静默扩大成全项目查询。
历史库里残留的图外状态不会被静默吞掉：`summary.total` 以实际列表行数为准，
`unknownStatusCount` 单列这些行，KPI 页签也用「历史未知状态」显式展示。

## 3. 接口语义

| 能力 | HTTP | CLI | MCP |
|---|---|---|---|
| 列表 + KPI | `GET /api/requirements?projectId=&status=` | `requirement list [--project <ref>] [--status <s>]` | `requirement_list` |
| 创建并关联文档 | `POST /api/requirements` | `requirement create --project <ref> --name <名>` | `requirement_create` |
| 状态流转 | `POST /api/requirements/:id/transition` | `requirement transition <ref> --status <s>` | `requirement_transition` |

错误统一：非需求节点流转 / 未知状态 / 非法跳转都返回 `VALIDATION_FAILED`（HTTP 400）。

## 4. UI 说明

- 顶栏新增「需求管理」页签，进入后按项目筛选，默认选第一个项目。
- KPI 六项：总数、进行中、提测中、已完成、缺需求内容、缺概要设计。
- 每行状态列只展示当前状态，操作列只展示状态机允许的下一步，不提供任意状态下拉。
- 文档关联标签可点击打开复用 `DocPane`，编辑后刷新列表即可看到就绪状态变化。

## 5. 关联章节

- 数据模型：`docs/design/02-data-model.md` §4.1 nodes / §4.6 documents
- 接口清单：`docs/design/04-api.md`「需求管理」段
- 接口示例：`docs/api.md`
- 测试策略：`docs/design/08-testing.md`
- 相邻功能：`../documents/`、`../requirement-readiness/`、`../delivery-gate/`

# 功能：需求管理（需求条目 / 状态流转 / 文档关联）

- 代码：`server/store.mjs`、`server/http.mjs`、`server/cli.mjs`、`server/mcp.mjs`、`web/src/views/RequirementsView.vue`
- 入口：HTTP（`/api/requirements`）· CLI（`requirement list|create|transition`）· MCP（`requirement_list` / `requirement_create` / `requirement_transition`）
- 主设计文档：`../../docs/design.md` §4.1 / §4.6 / §4.8；接口参考 `../../docs/design/04-api.md`

## 1. 目标

现有数据层已经能存需求节点、状态和文档，但 Web 和 AI 入口只有通用任务树，没有
「需求管理」的稳定流程：建需求后要手工补文档、状态可以任意改、列表也看不出哪些文档没关联。

本功能做第一个可合并的端到端垂直切片：把「需求条目创建 → 文档关联 → 状态流转 → 列表/KPI」
收敛为一条明确路径，同时保持底层仍复用 `nodes` + `documents`，不新增表。

## 2. 需求点

- R1 专属列表：只列 `requirement` 节点，返回项目、属性、文档关联状态、就绪结论和可流转状态。
- R2 创建即关联：新建需求时自动关联「需求内容」与「概要设计」两份文档，避免半成品条目。
- R3 状态机：`todo → doing → testing → done`；未完成前可 `cancelled`；`cancelled → todo` 可恢复；
  `done` 不可回退。非法跳转与枚举外状态返回 `VALIDATION_FAILED`，通用 create/update/upsert/batch
  也不能绕过；需求创建只允许从 `todo` 起始。
- R3a 配置收口：`config.status.allowed.requirement` 只能收窄上述 workflow，不能新增图外状态；
  含未知状态或缺 `todo` 的配置在启动期拒绝。收窄后 `canTransitionTo`、流转校验与 KPI 列必须共用同一有效状态集。
- R4 文档关联可见：列表显示每份核心文档是「未关联 / 空白 / 已填写」，并统计两类缺口。
- R5 三入口 1:1：HTTP / CLI / MCP 复用同一 store 能力，Web 只做参数装配和展示。
- R6 纯读列表不写库、不动 revision；创建和状态流转各只产生一次 revision。

## 3. 非目标（首版）

- 不做需求审批流 / 角色权限；
- 不自动生成需求正文或概要设计；
- 不做需求版本对比（文档历史已由 `documents` 功能单独承载）；
- 不扩展新的数据库表或字段。

## 4. 验收标准

- `test/store-requirements.test.mjs`：创建自动关联两文档、列表筛选与 KPI、状态机合法/非法路径、
  取消恢复、通用 create/update 对枚举外状态拒绝、通用创建与专属创建文档槽位一致。
- `test/requirements-http-mcp-cli.test.mjs`：HTTP 列表/创建/流转/错误码；CLI 真实子进程全链路；
  MCP 真实协议与 store 逐字段一致；通用 `nodes`/`upsert`/`batch` 创建收口，非法 projectId 拒绝。
- `npm run build` 成功，Web 端出现「需求管理」页签与文档抽屉。
- `npm test` 全绿；文档同步更新（本目录 + API 参考 + 功能索引 + 设计决策）。

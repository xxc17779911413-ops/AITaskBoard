# 功能：权限边界与操作审计

- 代码：`server/db.mjs`（`audit_logs` 表 + v6 迁移）、`server/errors.mjs`（`PERMISSION_DENIED`）、`server/store.mjs`（`checkRiskPermission` / `requireRiskPermission` / `recordAudit` / `listAuditLogs`，以及高风险写路径的闸门）、`server/ops.mjs`（派单闸门）、`server/{http,cli,mcp}.mjs`、`web/src/views/AuditView.vue` + `web/src/audit.js`
- 入口：HTTP（`GET /api/audit-logs`；高风险写接口新增 `confirm`）· CLI（`audit list`；`--confirm`）· MCP（`audit_list`；`confirm` 参数）· Web（顶栏「操作审计」）
- 主设计文档：`../../docs/design/04-api.md`、`../../docs/design/06-ui.md`、`../../docs/design/07-errors.md`

## 1. 目标

AI / agent 现在是 TaskBoard 的主要操作者，但高风险操作（上线检查、回归派单、状态流转、配置 / SQL 变更）
此前和普通写操作一样直接执行，没有权限边界、没有最小审批、也没有可追溯记录。本功能补一个**最小而可合并**的切片：
对这几类高风险操作做权限判定 + 最小确认机制 + 操作审计留痕，并提供只读查看入口。复用现有节点 / 报告模型，
不引入完整 RBAC。

## 2. 需求点

- R1 高风险操作（action）固定四类：`release.check`（上线检查派单）/ `regression.run`（回归派单）/
  `requirement.transition`（需求状态流转）/ `release.item.write`（上线配置 / SQL 变更：新增 / 更新 / 删除）。
- R2 权限判定（`checkRiskPermission`，纯函数）：
  - 人工通道（`user` / `cli` / `import`）→ 直接放行（已经有人在场）；
  - AI 通道（`ai` / `mcp`）→ 需要显式 `confirm:true`，否则拒绝；
  - 未知 action → `VALIDATION_FAILED`（不当作放行）。
- R3 最小确认机制：AI 触发高风险操作必须显式 `confirm:true`；**dryRun 预演不受限**（只读、不派单）。
  拒绝时返回 `PERMISSION_DENIED`（HTTP 403；MCP `isError`，不泄漏 SDK `-32602`），且拒绝同样留痕。
- R4 操作审计日志（`audit_logs`）：每类高风险操作无论 `allowed` / `denied` / `confirmed` 都写一条，含
  `action` / `nodeId` / `actor` / `decision` / `reason` / `detail` / `createdAt`。
- R5 可追溯查看：`listAuditLogs` 支持按 `action` / `nodeId` / `decision` / `limit` 筛选、倒序；三入口 1:1；
  Web「操作审计」页展示 KPI 与明细，节点可跳转。
- R6 审计是旁路观测：写审计日志**不额外 bump revision**（不放大数据版本噪声）。
- R7 闸门位置：权限判定发生在真正的写操作 / 派单**之前**——被拒时不产生节点状态变更、报告或 agent 任务。

## 3. 非目标（首版）

- 不做完整 RBAC（角色 / 权限矩阵 / 用户体系）；只区分「人工通道」与「AI 通道」。
- 不做审批工作流（多级审批 / 待办队列）；首版是最小「显式确认」。
- 不覆盖全部写操作——只覆盖 PM 点名的四类高风险操作。
- 不持久化审批流状态；`pending` 结论在值域里预留，首版不产生。

## 4. 验收标准

- `test/audit-permission.test.mjs`：权限判定（人工放行 / AI 需确认 / 未知 action 拒绝）；`PERMISSION_DENIED` 留 denied 审计；
  状态流转、上线项变更、两类派单的闸门（dryRun 不受限、真派单 AI 未确认被拒且无副作用）；审计筛选 / 倒序 / 非法值；审计不 bump revision。
- `test/audit-permission-entrypoints.test.mjs`：HTTP 403 + `PERMISSION_DENIED`、确认后放行、人工放行、审计可见、非法筛选 400；
  CLI（`--confirm`、`audit list` 与 store 一致）；MCP（`isError` 不含 `-32602`、确认后放行、`audit_list` 一致）。
- `test/audit-view.test.mjs`：展示口径（值域、标签、KPI 分桶、按 action 计数）。
- `npm test` 全绿；`npm run build` 通过；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/design/06-ui.md` + `docs/design/07-errors.md` + `docs/api.md` + `features/README.md`）。

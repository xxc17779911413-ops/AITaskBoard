# 提交记录：权限边界与操作审计

- feat(audit-permission): 权限边界与操作审计纵向切片——新增 `audit_logs` 表（v6 迁移）+ `PERMISSION_DENIED` 错误码；`checkRiskPermission`/`requireRiskPermission`/`recordAudit`/`listAuditLogs` 单点定义四类高风险操作（release.check / regression.run / requirement.transition / release.item.write）；人工通道（user/cli/import）放行、AI 通道（ai/mcp，含历史 actor）需显式 confirm，闸门放在副作用之前（拒绝不产生状态变更/报告/agent 任务），审计无论放行/拒绝/确认都留痕且不 bump revision；三入口 1:1（HTTP 403 + `/api/audit-logs`、CLI `--confirm` + `audit list`、MCP `confirm` + `audit_list`）；Web 顶栏「操作审计」页（KPI + 明细 + 节点跳转，`web/src/audit.js` 纯展示口径）；补 store/入口/展示口径回归

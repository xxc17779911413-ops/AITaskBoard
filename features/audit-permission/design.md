# 设计：权限边界与操作审计

## 1. 数据结构

`audit_logs(id, action, node_id, actor, decision, reason, detail, created_at)`：

- `action` ∈ `release.check` / `regression.run` / `requirement.transition` / `release.item.write`；
- `decision` ∈ `allowed` / `denied` / `confirmed` / `pending`（`pending` 首版预留）；
- `actor` 存**稳定通道名**（`user` / `cli` / `import` / `ai`），不是原始输入；
- `detail` 是 JSON 文本（如状态流转的 from/to、派单的 caseIds），读取时解析回对象；
- `idx_audit_logs_created` / `idx_audit_logs_node` 支撑倒序与按节点查询；`node_id` 无外键（审计不随节点级联删除）。

SCHEMA 对新库生效，`migrate()` 的 v6 段对老库幂等补表。

## 2. 关键规则

**R1 通道判定不能用 `actor()`**：`actor()` 把未知值（含历史 MCP 用的 `'mcp'`）统一归一成 `'user'`，
若直接用它做权限判定，自动触发者会被误判成「有人在场」而绕过审批。因此新增 `riskChannel(by)`：
先看**原始值**——`ai` / `mcp` → `ai`（需确认），`cli` → `cli`，`import` → `import`，其余 → `user`。
审计里也记这个稳定通道名，便于事后按通道统计。

**R2 三态复用**：`checkRiskPermission` 返回 `{ allowed, requiresConfirm, reason }`；
`requireRiskPermission` 在其上「判定 → 留痕 → 拒绝时抛 `PERMISSION_DENIED`」，
放行返回 `{ ok:true, audit }`。所有高风险路径共用这一条，避免各写各的。

**R3 闸门必须在副作用之前**：

- 状态流转：`transitionRequirement` 先过状态机校验，再 `requireRiskPermission`，最后才 `updateNode`；
- 上线项：`createReleaseItem` / `updateReleaseItem` / `deleteReleaseItem` 在值域校验后、落库前判定；
- 派单：`runTestCases` / `runReleaseChecks` 的 `dryRun` 分支**先返回**（预演只读、不需要确认），
  真派单在 `startAgentRun` 之前判定——被拒时不产生 agent 任务与 `running` 报告。

**R4 审计不 bump revision**：审计是旁路观测，不该放大数据版本噪声；`recordAudit` 只写 `audit_logs`。

**R5 值域统一**：`action` 与 `decision` 都走 `RISK_ACTIONS` / `AUDIT_DECISIONS` 单点定义；
未知值一律 `VALIDATION_FAILED`（不静默降级、不当放行）。

**R5.1 分页参数也按业务值域拒绝**：`listAuditLogs` 的 `nodeId` 必须是正整数、`limit` 必须是
`1..500` 的整数，否则 `VALIDATION_FAILED`。不能静默把非法 `nodeId` 当成「查无结果」（返回 `[]`），
也不能让 `limit=-1` 落到 SQLite 的 `LIMIT -1`（= 不限条数）把全表返回。
三入口都不做 zod 强类型前置：`decision` / `nodeId` / `limit` 用宽松类型接收，统一交给 `listAuditLogs`
校验并转 `VALIDATION_FAILED`，避免 MCP 在 handler 前被 zod 拦成 SDK `-32602`（与 `action` 同一条纪律）。

## 3. 对外接口

```js
checkRiskPermission(action, { actor, confirm })        // → { allowed, requiresConfirm, reason, action, actor }
requireRiskPermission(action, { actor, confirm, nodeId, detail }) // → { ok, audit }；拒绝抛 PERMISSION_DENIED
recordAudit({ action, nodeId, actor, decision, reason, detail })  // → AuditVO
listAuditLogs({ action, nodeId, decision, limit })     // → AuditVO[]（倒序）
```

三入口：
- HTTP：高风险写接口接 `confirm`（JSON body / `delete` 的 `?confirm=true`）；`GET /api/audit-logs` 只读查看；
- CLI：`--confirm` 透传到各写命令；`audit list [--action] [--decision] [--node-id] [--limit]`；
- MCP：高风险 tool 接 `confirm` 参数；`audit_list` 只读；错误经 `mcpValidate` 转 `isError`，不泄漏 `-32602`。

## 4. 错误码

新增 `PERMISSION_DENIED`（HTTP 403）：AI 触发高风险操作但未显式确认。
`details` 带 `action` / `actor` / `confirmRequired` / `auditId`，便于调用方自纠（拿 auditId 去查留痕）。

## 5. 关联章节

- 接口表：`docs/design/04-api.md`
- 错误码：`docs/design/07-errors.md`
- UI：`docs/design/06-ui.md`（顶栏「操作审计」）
- 相邻功能：`features/regression-loop/`、`features/release-governance/`、`features/requirement-management/`

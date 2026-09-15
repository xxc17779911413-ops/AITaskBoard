# 功能设计：交付证据快照

## 1. 模块职责

- `server/db.mjs`：新增 `delivery_snapshots` 表与 v6 幂等迁移。
- `server/store.mjs`：
  - `captureDeliverySnapshot(nodeId, { scope, note }, by)`
  - `listDeliverySnapshots(nodeId, { scope, limit })`
  - `getDeliverySnapshot(id)`
  - `stableJson` / `deliveryFingerprint` / `deliverySnapshotVO` 作为内部单一实现。
- `server/http.mjs` / `cli.mjs` / `mcp.mjs`：三入口 1:1 暴露 capture / list / get。
- `server/ops.mjs`：`renderDeliverySnapshotMd` + `TOOLS` 能力清单登记。
- `web/src/components/NodeDrawer.vue` + `web/src/api.js`：「交付」页快照冻结按钮、列表与漂移标签。

## 2. 关键规则

**R1 快照保存完整门禁，不只保存结论**：只存 `ready/not_ready` 无法解释“凭什么”，
因此 `gate_json` 保存 `buildDeliveryGate` 的完整返回（sources / evidence / blockers / totals）。

**R2 指纹是稳定 JSON 的 SHA-256，且漂移只认证据集合**：对象 key 顺序不能影响等值判断。
写入时对完整门禁做键排序后哈希；读取时用同一算法重算当前门禁，指纹相同为 `current`，不同为 `drifted`。
指纹前会递归剔除两列非语义字段：展示字段 `name` / `path` / `label`（改名、路径调整、文案翻译不触发漂移），
以及审计元数据 `createdAt` / `updatedAt` / `createdBy` / `updatedBy`（no-op 重存或仅改备注人的时间戳不触发漂移）。
`id` / `kind` / `status` / `required` / `content` / `rollback` / `totals` / `checks` / `reports` 等证据字段仍完整参与指纹。

**R3 历史不可变、现状实时核对**：`delivery_snapshots` 只插入不更新。读取时在内存中重建当前门禁；
`drift.currentDecision` 是现状，`snapshot.decision` 是冻结结论，两者绝不混成一个字段。

**R4 显式写入才产生 revision**：实时门禁仍纯读；只有 `captureDeliverySnapshot` 是业务写操作，
一次捕获只调用一次 `bumpRevision()`。列表 / 单条读取不写库。

**R5 审计身份不允许降级**：store 的 actor 白名单补齐 `mcp` / `system`。
MCP 工具回写 `created_by=mcp`，避免审计记录被错误记成 `user`。

**R6 快照可导出**：`renderDeliverySnapshotMd` 同时输出冻结结论、当前核对、指纹与冻结依据，
可直接贴进验收 / 上线记录；标题、备注和 markdown 表格单元格统一沿用反斜杠 / 竖线转义纪律，
按 CommonMark 行结束符口径把 `CRLF / CR / LF` 统一压成单行，并对 `#` 做标题标记转义；
用户可写文本不得凭空生成新章节、围栏或伪造证据表格。

## 3. 接口语义

| 能力 | HTTP | CLI | MCP |
|---|---|---|---|
| 冻结快照 | `POST /api/nodes/:id/delivery-snapshots` | `delivery snapshot <ref>` | `delivery_snapshot_capture` |
| 快照列表 | `GET /api/nodes/:id/delivery-snapshots` | `delivery snapshots <ref>` | `delivery_snapshot_list` |
| 单条读取 | `GET /api/delivery-snapshots/:sid` | `delivery snapshot-get <sid>` | `delivery_snapshot_get` |

`scope` 继续由 `store.normalizeScope` 单点校验；非法值 / 不存在快照分别返回
`VALIDATION_FAILED` / `NOT_FOUND`。

## 4. 数据与生命周期

- `node_id` FK `ON DELETE CASCADE`：节点删除后快照同步清理，不留孤儿审计记录。
- `gate_json` 是冻结真相；未来门禁结构升级时必须明确迁移或版本化，不能静默重解释旧 JSON。
- `limit` 上限 200，缺省 50，倒序返回。

## 5. 关联章节

- 数据模型：`docs/design/02-data-model.md` §4.17
- 接口表：`docs/design/04-api.md`「交付门禁」
- 接口示例：`docs/api.md`「交付证据快照」
- UI：`docs/design/06-ui.md` §8.2
- 测试策略：`docs/design/08-testing.md`
- 决策：`docs/design/09-decisions.md` 决策 37
- 相邻功能：`../delivery-gate/`、`../regression-loop/`、`../release-governance/`

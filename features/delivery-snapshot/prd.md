# 功能：交付证据快照（验收留痕 / 上线审计）

- 代码：`server/db.mjs`、`server/store.mjs`、`server/{http,cli,mcp,ops}.mjs`、`web/src/components/NodeDrawer.vue`
- 入口：HTTP（`/api/nodes/:id/delivery-snapshots`、`/api/delivery-snapshots/:sid`）· CLI（`delivery snapshot|snapshots|snapshot-get`）· MCP（`delivery_snapshot_capture` / `delivery_snapshot_list` / `delivery_snapshot_get`）
- 相邻功能：`../delivery-gate/`、`../regression-loop/`、`../release-governance/`

## 1. 目标

现有交付门禁是实时只读聚合：它回答「现在能不能交付」，但不能回答「当时凭什么放行」。
报告、用例或上线项后续变化时，历史结论会直接漂移；验收与上线审计缺少可冻结、可核对的证据记录。

本功能补一条显式的证据快照闭环：把某一刻的交付门禁结论与完整依据冻结下来，
后续读取时再与当前证据核对，明确标记 `current` / `drifted`。

## 2. 需求点

- R1 显式冻结：`capture` 保存节点、范围、冻结结论、完整门禁 JSON 与稳定指纹，不允许静默后台生成。
- R2 不可变历史：快照写入后不随源数据变化改写；`drifted` 只表达「现状不同」，不覆盖冻结结论。
- R3 可核对：读取快照或列表时实时重算当前门禁并比较指纹，返回 `current` / `drifted`。
- R4 范围隔离：`self` / `subtree` 独立存取；非法 `scope` 一律 `VALIDATION_FAILED`。
- R5 三入口 1:1：HTTP / CLI / MCP 都提供 capture / list / get，复用同一 store 能力。
- R6 审计与生命周期：快照记录操作者；写入只递增一次 revision；节点删除时快照级联清理。
- R7 可交付导出：单条快照支持 `format=md`，同时展示冻结结论与当前核对状态。

## 3. 非目标（首版）

- 不替代实时 `delivery_gate`；快照不是自动更新或长期缓存。
- 不引入审批签核流、电子签名或不可篡改的区块链存证。
- 不对快照做编辑 / 删除；首版只追加和读取。

## 4. 验收标准

- `test/delivery-snapshot.test.mjs`：冻结门禁 JSON 与 64 位指纹、revision 只 +1、`current` / `drifted`、
  `scope` 隔离、非法 scope / 不存在 id、节点删除级联、HTTP / CLI / MCP 全链路、能力清单登记。
- MCP 真实协议写入的操作者必须记录为 `mcp`，不得被 store 白名单降级成 `user`。
- `npm run build` 成功；NodeDrawer「交付」页可冻结并展示 `一致 / 已偏离`。
- `npm test` 全绿；文档同步更新（数据模型 / API / UI / 测试 / 决策 / 功能索引）。

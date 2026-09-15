# 功能：交付门禁（需求就绪 / 测试验收 / 上线治理 / 代码推送的最终汇总）

- 代码：`server/store.mjs`（`buildDeliveryGate`）、`server/ops.mjs`（`buildDeliveryGateFull` / `renderDeliveryGateMd`）、`server/{http,cli,mcp}.mjs`、`web/src/components/NodeDrawer.vue`
- 入口：HTTP（`/api/nodes/:id/delivery-gate`）· CLI（`delivery gate <ref>`）· MCP（`delivery_gate`）
- 主设计文档：`../../docs/design/04-api.md`（接口表）；相邻功能：`../requirement-readiness/`、`../regression-loop/`、`../release-governance/`

## 1. 目标

TaskBoard 已经有三个独立结论：

- 需求就绪门禁回答「能不能进入测试」；
- 验收报告回答「测试过没过」；
- 上线检查清单回答「上线动作能不能执行」。

再加代码推送门禁回答「登记的提交有没有真的到远程」。四者分散在四个接口与页面片段里，调用方要自己拼装才敢说一句「这次能不能交付」。
本功能补上唯一入口：把四段既有结论收敛成一个确定、可贴进 issue / 上线单的交付结论。

## 2. 需求点

- R1 门禁挂在任意节点上；`scope=self` 只判定本节点，`scope=subtree` 纳入子树。
- R2 汇总四个来源：
  - `readiness`：复用 `buildRequirementReadiness`；
  - `acceptance`：复用 `buildAcceptanceStatus`（测试证据 + 验收签收有效性）；
  - `release`：复用 `buildReleaseChecklist`。
  - `acceptance`：复用 `buildAcceptanceReport`；
  - `release`：复用 `buildReleaseChecklist`；
  - `push`：复用 `getNodePushGate`（登记提交是否真的到了远程；异步，由 `ops.buildDeliveryGateFull` 注入）。
- R3 每个来源使用三态：`pass` / `fail` / `not_applicable`。不适用不等于通过，也不阻塞。
- R4 最终结论使用三态：
  - `ready`：至少一个来源适用，且所有适用来源均 `pass`；
  - `not_ready`：任一适用来源 `fail`；
  - `unknown`：所有来源都 `not_applicable`（没有可判定的交付证据）。
- R5 `ready` 字段对 `unknown` 返回 `null`，避免把「没有证据」伪造成绿灯。
- R6 返回 `sources`（四个来源及依据）、`blockers`（拆到条目级的阻塞项）、`totals`（适用 / 通过 / 未通过 / 不适用计数）。
- R7 支持 `format=md`，可直接贴进 issue、验收记录或上线单。
- R7a `scope` / `format` 都是枚举参数：`scope=self|subtree`、`format=json|md`；缺省分别取 `self` / `json`，其它值一律 `VALIDATION_FAILED`（三入口一致，不静默降级）。
- R8 Web 抽屉新增「交付」页签：可切换 `self` / `subtree`，直接展示结论、来源与阻塞项。

## 3. 非目标（首版）

- 不新增数据表：门禁是既有数据的只读聚合，不落库、不 bump revision。
- 不自动补需求文档、用例或上线项；只给结论与阻塞项。
- 不替代验收报告 / 上线清单的明细接口；它是最终汇总入口，不是明细的唯一来源。
- 不引入审批流或人工签核状态。
- 停用测试用例不参与门禁：`enabled=0` 的用例既不算 notRun，也不阻塞交付（与 readiness 的「启用中的可回归用例」口径一致）。
- `push` 只读本机 `refs/remotes/*`，不 `fetch`、不 `push`：门禁给结论，不做网络副作用。

## 4. 验收标准

- `test/delivery-gate.test.mjs`：空证据 `unknown`；需求就绪但测试未执行 `not_ready`；`not_run` / `running` 显式分桶与 blocker 明细；四段通过 / 不适用不阻塞 `ready`；必做上线项未完成覆盖测试通过结论；停用用例不参与门禁；`scope=subtree` 联动；纯读不产生 revision；markdown 转义；能力清单登记。
- `test/delivery-gate-push.test.mjs`：登记提交未 push / 无法判定都阻塞交付；push 后翻成 `ready`；范围内无登记提交时 `push` 来源 `not_applicable`；`scope=subtree` 纳入子树提交且同 `(repo,sha)` 去重；同步入口漏传推送证据时不放行。
- `test/delivery-gate-mcp.test.mjs`：MCP 真实协议调用、`format=md`、非法 `scope` / `format` 拒绝、四入口逐字段一致。
- `test/http.test.mjs`：全链路（需求就绪 → 测试未跑不可交付 → 报告 pass 后可交付）、`format=md`、空证据 `unknown`。
- `npm test` 全绿；三入口 1:1；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/api.md`
  + `docs/design/06-ui.md` + `docs/design/08-testing.md` + `docs/design/09-decisions.md` + `features/README.md`）。

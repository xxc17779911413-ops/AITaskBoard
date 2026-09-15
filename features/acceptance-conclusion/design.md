# 设计：验收结论（按需求 / 版本）

## 1. 模块职责

- `server/store.mjs`：`buildAcceptanceConclusion(nodeId, { scope, version })` 是唯一聚合点。
  - 复用 `buildAcceptanceReport`（逐用例最近结果、通过率）；
  - 复用 `buildRequirementReadiness`（逐需求需求内容 / 概要设计 / 可回归用例门禁）；
  - 读取节点 `version` 属性作为分组轴。
- `server/ops.mjs`：`renderAcceptanceConclusionMd` 渲染成可贴进 issue 的 markdown。
- `server/{http,cli,mcp}.mjs`：三入口 1:1 暴露，只做参数装配。
- `web/src/components/RegressionPane.vue`：在「回归测试」页签内展示逐需求结论与文档缺口。

## 2. 关键规则

**R1 为什么在 store 聚合**：结论必须随源数据实时变化，落表会产生第二份真相；
与 `acceptance_report` / `readiness` / `delivery_gate` 同一条「结论不落库」原则。

**R2 逐需求结论**：`decision = not_applicable`（无证据）/ `fail`（有用例非全 pass，或文档门禁未过）/ `pass`。
「有用例但没给结论」不等于通过——未执行 / 执行中都算 `fail`，与 acceptance 的 settled 口径一致。

**R3 版本轴**：版本是节点的普通属性（attribute key = `version`），不是新表。
`version` 参数过滤在聚合之后按属性值匹配；过滤后没有需求时整体回到 `unknown`（`ready=null`），
不要把「这个版本还没建需求」显示成「验收未通过」。

**R3.1 过滤后 KPI 必须同源**：`totals.cases` / `testPass` / `testFail` 由**过滤后的 `items`** 重算
（`cases = Σ item.caseCount`，`testPass = Σ item.latestStatuses 中 pass 数`，`testFail = cases - testPass`），
**不能**直接引用全范围的 `acceptance.totals`——那个聚合没有 version 维度，会让「按版本过滤」后
Web 摘要与 markdown 导出显示比明细更大的用例数，与 `items` / `decision` 自相矛盾。

**R4 空态**：`applicable = pass + fail`；`applicable === 0` 时 `decision=unknown`、`ready=null`。

**R5 阻塞项**：展平为 `{ nodeId, name, source: 'test'|'document', label, detail }`，
便于调用方直接从 `blockers` 生成待办，不必再遍历 `items`。

**R6 值域**：`scope` / `format` 走 `store.normalizeScope` / `store.normalizeFormat`，非法值一律 `VALIDATION_FAILED`。

## 3. 关联章节

- 接口表：`docs/design/04-api.md`「验收结论」段
- UI：`docs/design/06-ui.md` §8.2 抽屉「回归测试」页签
- 相邻功能：`features/regression-loop/`、`features/requirement-readiness/`、`features/release-governance/`、`features/delivery-gate/`

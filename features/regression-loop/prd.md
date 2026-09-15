# 功能：回归测试闭环（AI 可回归测试 → 测试/验收报告）

- 代码：`server/store.mjs`（test_cases / test_reports 部分）、`server/ops.mjs`（runTestCases / composeTestPrompt / renderAcceptanceMd）、`server/db.mjs`（表结构）
- 入口：HTTP（`/api/nodes/:id/test-cases`、`/test-runs`、`/test-reports`、`/acceptance-report`）· CLI（`test case|run|report|acceptance`）· MCP（`test_case_*` / `test_run` / `test_report_*` / `acceptance_report`）
- 主设计文档：`../../docs/design.md` §4.14（数据模型）；`../../docs/design/04-api.md`（接口表）

## 1. 目标

打通一条最小可交付纵切：**需求 → 概要设计/文档 → AI 可回归测试 → 测试/验收报告**。

- 需求 / 概要设计已经由节点树与多份 markdown 文档承载（见 `documents/`）；
- 本功能补上后两段：把「可被 AI 重复执行」的测试指令沉淀为**测试用例**，把每次执行的结果沉淀为**报告**，并聚合出**验收报告**。

## 2. 需求点

- R1 测试用例挂在任意节点上（项目 / 需求 / 子需求 / 任务组 / 子任务 / 缺陷），同节点内**按名唯一**。
- R2 用例字段：名称、类型 `kind`、提示词 `prompt`（AI 执行指令）、期望结果 `expectation`、启停 `enabled`、排序 `sort`。
- R3 `kind` 是**统一扩展轴**：v1 实现 `regression`（回归）/ `acceptance`（验收），并在表约束里预留 `code_check`（代码检查）/ `biz_check`（业务检查）/ `release_check`（上线检查）。新增一类检查只加用例，不改表结构与三个入口。
- R4 按名 `upsert` 幂等（AI 友好，与文档 upsert 语义一致）：已存在则更新内容与期望，返回 `created` 标记。
- R5 执行：把选中用例拼成一段可执行提示词，派单到该节点（复用 agent 运行时 / 会话 / 任务），并立刻为每条用例开一条 `running` 报告；`dryRun` 只返回将要执行的用例与提示词，不落库、不派单。
- R6 报告：一次执行 = 一行，状态 `running / pass / fail / blocked / error / cancelled`，可关联用例（`case_id`）与 agent 任务（`run_id`）。
- R7 验收报告：按节点（`self` 或 `subtree`）聚合每个用例的**最近一次结果**、通过率与未覆盖清单；分桶**总数守恒**（`pass+fail+blocked+error+cancelled+running+notRun=cases`），`running` / `notRun` 不计入通过率分母（`settled` 口径）；支持 `format=md` 直接贴进 issue / MR。
- R7b 报告状态机：`running → 终态` 单向；终态重复提交同状态幂等；终态互转 / 回退 `running` 默认拒绝（`REPORT_STATUS_IMMUTABLE`），`overwrite:true` 显式覆盖；非法 `status` 应用层拦成 `VALIDATION_FAILED`。
- R7c 引用完整性：报告 `caseId` 必须与节点同属，`runId` 必须存在（否则 `VALIDATION_FAILED` / `NOT_FOUND`）。
- R8 审计：所有写入 `revision` +1，并记录 `created_by` / `updated_by`（user / ai / cli / import / mcp）。

## 3. 非目标（首版）

- 不做用例的自动生成（由 AI 通过 MCP 自行撰写并 upsert）；
- 不做报告的定时重跑 / 并发调度（派单仍是一次一单，复用 agent 运行时）；
- 不实现 `code_check` / `biz_check` / `release_check` 的专用执行器——它们先作为 `kind` 值可用，执行走同一条 agent 派单链路；
- 不做上线配置 / 上线 SQL 的自动执行，只保留 `release_check` 这一扩展点。

## 4. 验收标准

- `test/test-case.test.mjs`：用例 CRUD、按名唯一与 upsert 幂等、`kind` 筛选、启停、排序、随节点级联删除；报告的开启 / 回写 / 筛选 / 删除用例后保留历史；验收报告聚合（最近结果、通过率、未执行口径）、`scope=subtree`、空态；编排层 `dryRun` 与提示词拼装。
- `test/http.test.mjs`：全链路（upsert → dryRun → 报告 → 验收报告）、重名返回 `TEST_CASE_NAME_EXISTS`、报告列表 / 单条 / 回写终态。
- `test/regression-view.test.mjs` + `test/http.test.mjs`「回归面板」：Web 面板（`RegressionPane.vue` + `regression.js`）的展示口径——通过率「已完结」口径、分桶总数守恒、`not_run` 显示为「未执行」、KPI 与报告列表一致；并按面板实际调用序列打 HTTP（用例 upsert / 筛选 / dryRun / 报告列表 / 回写 / 验收 / 删除用例保留历史）。
- `npm test` 全绿；三入口 1:1；文档同步更新（本目录 + `docs/design/02-data-model.md` + `docs/design/04-api.md` + `docs/api.md` + `features/README.md`）。

# 功能设计：回归测试闭环

## 1. 模块职责

- `server/db.mjs`：新增 `test_cases` / `test_reports` 两张表（SCHEMA 对新库生效，`migrate()` 对老库幂等补表）。
- `server/store.mjs`：唯一读写核心。
  - 用例：`createTestCase` / `listTestCases` / `getTestCase` / `upsertTestCase` / `updateTestCase` / `deleteTestCase` / `reorderTestCases`
  - 报告：`createTestReport` / `listTestReports` / `getTestReport` / `finishTestReport`
  - 聚合：`buildAcceptanceReport`（按节点或子树汇总最近结果与通过率）
- `server/ops.mjs`：跨 store 的编排，不绑定入口。
  - `runTestCases`：选用例 → 拼提示词 → `startAgentRun` 派单 → 开 running 报告；`dryRun` 走纯预演分支。
  - `composeTestPrompt`：把用例拼成给 agent 的回归指令（显式要求 `PASS|FAIL|BLOCKED` 逐条结论）。
  - `renderAcceptanceMd`：聚合结果 → markdown 验收报告。
- `server/http.mjs` / `cli.mjs` / `mcp.mjs`：三入口 1:1 暴露（只做参数装配 + 错误映射）。

## 1.1 Web 面板（RegressionPane）

抽屉「回归测试」页签（`web/src/components/RegressionPane.vue`）复用上面同一套 HTTP 接口，不新增后端语义：

- 顶部验收 KPI 消费 `GET /api/nodes/:id/acceptance-report` 的 `totals`，口径与后端一致
  （`running` / `notRun` 不进通过率分母，无完结显示「—」）；`web/src/regression.js` 是纯展示函数，可单测。
- 用例区：`GET/POST /api/nodes/:id/test-cases`（含 `kind` / `includeDisabled` 筛选）、`PATCH/DELETE /api/test-cases/:cid`。
- 运行区：先 `POST /api/nodes/:id/test-runs {dryRun:true}` 预览提示词，再派单；派单后报告由后端开为 `running`。
- 报告区：`GET /api/nodes/:id/test-reports`（倒序、可按 `caseId` 筛）、`GET /api/test-reports/:rid`、
  `PATCH /api/test-reports/:rid` 回写终态。面板只做展示与触发，状态机、引用完整性、自动收尾都留在 store。

## 2. 关键规则

**R1 为什么挂在任意节点上**：需求 / 子需求 / 任务组 / 子任务都可能需要回归；缺陷也常需要复现验证。
用统一的 `node_id` 挂载，避免为每类节点各建一张表。

**R2 `kind` 作为扩展轴**：表约束里直接列出五个取值，v1 只实现前两个的执行语义，
其余三个（`code_check` / `biz_check` / `release_check`）先可用作分类标签——
上线配置 / 上线 SQL / 代码检查 / 业务检查的后续需求可以**只加用例与检查器**，不动表结构与入口契约。

**R3 upsert 幂等**：AI 反复调用 `test_case_upsert` 安全（与 `doc_upsert` 一致）；
按 `(node_id, name)` 唯一，`created` 标记让调用方知道是新建还是覆盖。

**R4 执行与报告解耦**：`runTestCases` 只负责「派单 + 开报告」，不阻塞等待 agent 结果。
agent 任务结束后由前台执行者（或后续收尾钩子）用 `test_report_finish` 逐条回写 pass/fail。
这样复用现有 agent 运行时（qodercli 后台 / Qoder IDE 前台 ideMode），不引入新的执行器。

**R5 报告状态机**（`running → 终态` 单向，实现与文档的唯一依据）：

| 当前 | 目标 | 行为 |
|---|---|---|
| `running` | 任一终态（`pass` / `fail` / `blocked` / `error` / `cancelled`） | 允许，写入 `finished_at` |
| 任一终态 | **同**一状态（重复提交） | 幂等：只更新 `summary` / `detail` / `run_id`，**不改** `finished_at` |
| 任一终态 | 其它状态（含回退 `running`） | 默认**拒绝**：409 `REPORT_STATUS_IMMUTABLE`（`details` 带 current / next） |
| 任一终态 | 其它状态 + 显式 `overwrite:true` | 允许显式覆盖（纠正误判用）；`finished_at` 归属见下 |
| 自动收尾的终态（`auto_finalized=1`） | 其它状态 | **允许**：自动结论只是机器兜底，人工确认无需 `overwrite`；改完清除 `auto_finalized`，之后归人所有 |
| `running` | `running` | 允许（刷新摘要，仍在执行） |

非法 `status` 一律在应用层拦截为 `VALIDATION_FAILED`，**不**落到 DB CHECK 约束（避免泄漏 `ERR_SQLITE_ERROR`）。

**R5.0 `overwrite` 时 `finished_at` 的归属**：`overwrite` 只改「判定结论」，不改「真实的完成时刻」。
终态 → 另一终态时**保留**原 `finished_at`（不刷新、不置空）；终态 → `running` 则**清空** `finished_at`
（回到执行中，尚无完成时刻）；`running` → 终态才写入新的 `finished_at`。
终态重复提交同状态本就不改 `finished_at`（幂等），`overwrite` 亦不重置。

**R5.1 派单自动收尾**：`runTestCases` / `runReleaseChecks` 派单后只开 `running` 报告；
任务落终态时 `finishAgentRun` / `cancelAgentRun` 会调用 `finalizeReportsForRun` 扫该 run 下仍 `running` 的报告并收尾，
结论优先从 agent 输出解析 `用例名: PASS|FAIL|BLOCKED - 依据`（`composeTestPrompt` 的契约，兼容 `通过/失败/阻塞` 与全角冒号）。
解析不到该用例结论时按 run 终态回落：`success → blocked`（**不报 pass**，避免把「跑成功但没给结论」伪造成绿灯）、
`timeout`/`cancelled → cancelled`、`failed → error`。收尾打 `auto_finalized=1` 标记，且只碰仍 `running` 的报告，
不覆盖人工已回写的终态；「收尾任务 + 收尾报告」用 `withoutBump` 合并为**一次** revision 递增。

**R6 验收分桶（总数守恒）**：

```
pass + fail + blocked + error + cancelled + running + notRun = cases
```

- `running` = 已派单但尚未回写（执行中）；`notRun` = 从未派单。二者**都不计入通过率分母**。
- 通过率 = `pass / (pass + fail + blocked + error + cancelled)`，即「已完结」口径；
  `settled` 字段就是该分母。无用例 / 无完结时 `passRate = null`（不是 0）。
- `error` 与 `blocked` 分列：`error` 是执行器/环境异常，`blocked` 是依赖缺失导致跑不了。

**R7 引用完整性**：`createTestReport` 校验 `caseId` 必须属于**同一节点**、`runId` 必须存在，
否则分别返回 `VALIDATION_FAILED` / `NOT_FOUND`；不允许跨节点错配（会让验收报告归错需求）。

**R8 历史保留**：删除用例时报告不删（`case_id` 经 `ON DELETE SET NULL` 置空），
历史执行记录仍可追溯。

**R9 三入口 1:1**：REST / CLI / MCP 暴露的字段集必须一致——
CLI `test case upsert|update --enabled true|false`、`test report finish --run-id N --overwrite` 与 HTTP body / MCP schema 对齐。

## 3. 踩坑 / 约束

- `runTestCases(store, nodeId, …)` 的第一个参数是 **store**，不是 node；三入口装配时别传错
  （HTTP / MCP / CLI 各有一处）；传错时 `dryRun` 会返回 `undefined` 而不是对象。
- 报告状态机只有「running → 终态」的语义约束，未在 DB 设触发器；
  该约束由 `finishTestReport` 在应用层强制：终态互转 / 回退 `running` 默认拒绝 `REPORT_STATUS_IMMUTABLE`，
  放行有且仅有两条：显式 `overwrite:true`，或该终态来自自动收尾（`auto_finalized=1`，人工改正机器兜底结论，见 R5 表格）。
- `runTestCases` 需要节点子树内有带本地路径的登记仓库才能真派单；
  纯用例管理（upsert / dryRun / acceptance）不依赖仓库，可在任意节点使用。
- **CLI 非 dry-run 必须等收尾**：`bin/taskboard.js` 在 `run()` resolve 后直接 `process.exit()`，
  而子进程收尾（`child.on('close')` → `finishAgentRun` → 报告自动收尾）跑在本进程事件循环里——
  进程一退出监听器再也不会被调用，任务与报告会永久停在 `running`（独立测试发现的缺陷）。
  因此 CLI 的 `test run` / `release check` 在非 dry-run 时用 `waitForAgentRun` 有界等待终态
  （缺省上限 30 分钟，`--wait-timeout 秒` 可调，`--no-wait` 显式退回只派单语义）；
  等待超时**不**算失败，返回当前状态并置 `waitTimedOut:true`，因为派单本身已成功。

## 4. 关联章节

- 数据模型：`docs/design/02-data-model.md` §4.14
- 接口表：`docs/design/04-api.md`「回归测试闭环」段
- 接口示例：`docs/api.md`
- 测试策略：`docs/design/08-testing.md`（单测分组：`test/test-case.test.mjs`）

# 功能：并行派单（test-fanout）

- 代码：`server/ops.mjs`（`runTestCases` 的 fanout 分支 + `normalizeMaxParallel`）、`server/{http,cli,mcp}.mjs`、`server/cli.mjs`（`settleCliDispatch`）
- 入口：HTTP（`POST /api/nodes/:id/test-runs` 的 `fanout` / `maxParallel`）· CLI（`test run --fanout --max-parallel N`）· MCP（`test_run` 的 `fanout` / `maxParallel`）
- 相邻功能：`../regression-loop/`（用例与报告的归属）、`../agent-runtime/`（一次 fan-out = N 个 agent 任务）、`../delivery-gate/`（验收口径不变）

## 1. 背景与目标

TaskBoard 的立项目标是「让 AI 按照流程完成需要并且**并行**的 agent 工具」。但回归测试派单
（`runTestCases`）一直是把选中用例**拼成一段提示词、派一个 agent 任务、共用一条 run**：

- 用例之间本来互相独立，串在一个 CLI 调用里必须依次跑完，**没有并行**；
- 任一用例失败或输出缺失会污染同一条输出的解析，其它用例的结论跟着不干净；
- 报告虽然按用例分行，但都挂在同一个 `run_id` 上，`agent_run_cancel` / 重试只能整批操作。

本功能补上「并行派单」这一段：**每条用例一个独立 agent 任务**，天然并行执行，
报告与任务一一对应，取消 / 重试 / 看输出都能落到单条用例。

## 2. 需求点

- R1 `fanout=false`（缺省）保持既有语义：一段提示词 + 一个 run + N 条报告。**向后兼容**，
  既有调用方与下游（delivery-gate / acceptance）不需要改。
- R2 `fanout=true`：每条选中用例派一个独立 agent 任务，各自独立提示词、独立输出、独立报告；
  返回 `runs[]` / `tasks[]`（case ↔ run ↔ report 三元组），`mode='fanout'`。
- R3 并行护栏 `maxParallel`：缺省 4、上限 16。执行器在本进程内异步 spawn、没有排队调度器，
  所以「选中数 > 护栏」**显式拒绝**（`VALIDATION_FAILED`，带 `selected` / `maxParallel` / `limit`），
  而不是静默截断——截断会让多出来的用例留下永远 running 的报告（假执行中）。
- R4 `maxParallel` 必须是 **number 类型的 1..16 整数**；`true` / `"4"` / `[1]` 等非 number 输入，
  以及 `0` / 负数 / 小数 / 超过上限，一律 `VALIDATION_FAILED`，不静默降级（与 `scope` / `format` 同一条纪律）。
  校验对 `fanout` 与 grouped **都生效**（非法值不得因为没走 fan-out 就被静默忽略）。
- R5 `dryRun=true` 在 fan-out 下只回报**将派哪些任务**与**各自的提示词**（逐条用例成段），不落库、不派单、不动 revision。
- R6 三入口 1:1：HTTP body / CLI `--fanout --max-parallel N` / MCP schema 字段集一致。
- R7 CLI 非 dry-run 的 fan-out 要等到**所有** run 终态再退出（复用 `waitForAgentRun` 逐个有界等待；
  轮询不占 agent 槽位，所以串行等待不削弱并行执行）；`waitTimedOut` 只要有一个没到终态即为 true。
  任一 run 是前台 `qoder-ide` 则整体不等待（`foreground=true`）。
- R8 收尾口径不变：每个 run 落终态时仍由 `finalizeReportsForRun` 逐条解析结论回写自己的那条报告；
  fan-out 下每个 run 只有一条报告，解析面更干净。
- R9 报告归属不变：报告仍挂回**用例所属节点**（`c.nodeId`），验收 / 交付门禁口径不受影响。
- R10 重试语义：重试是**一次新的执行**——`retryAgentRun` 建 child run 后，为父 run 关联的每条用例
  随 child run 开一条新的 `running` 报告（旧结论作为历史保留、不原地改写）；child run 落终态时
  `finalizeReportsForRun` 收尾该报告，验收报告按「最近一条」取到重试后的结论。
  不带用例报告的普通 agent 任务重试不凭空建报告；「建 child run + 随 child 报告」合并为**一次** revision 递增。

## 3. 非目标（首版）

- 不做进程级并发限流 / 排队调度（护栏只做「显式拒绝」，真正的队列留给后续调度层）；
- 不改 `test_cases` / `test_reports` 表结构与 `kind` 扩展轴；
- 不改 delivery-gate / acceptance 的聚合口径；
- `release check` 的 fan-out 本轮不做（先在设计上预留，见 design.md §4）。

## 4. 验收标准

- `test/test-fanout.test.mjs`：grouped 缺省行为不变（单 run + N 报告）；fan-out 每用例一个 run / 报告 /
  独立提示词；护栏拒绝与值域校验；**非 number 类型严格拒绝（HTTP / CLI / MCP 三入口口径一致）**；
  `dryRun` 不落库不动 revision；`caseIds` / `kind` 过滤；三入口字段一致；
  收尾后每条报告各自独立结论（一条 fail 不影响另一条 pass）。
- `test/agent.test.mjs` / `test/run-finalize.test.mjs`：**重试刷新用例报告**（缺陷 1 回归）——
  store 级（child 报告新建 / child 终态刷新 / 验收取重试结论 / 普通任务不建报告 / grouped 多用例 /
  只 +1 revision）与进程级真实 CLI `agent run retry` 端到端。
- `test/cli-regression-loop.test.mjs`：入口契约（HTTP body 字段、CLI `--fanout` / `--max-parallel`
  严格整数字面量与 grouped 下的拒绝）。
- `npm test` 全绿；三入口 1:1；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/api.md`
  + `docs/design/08-testing.md` + `features/README.md`）。

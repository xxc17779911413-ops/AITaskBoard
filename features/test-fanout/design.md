# 功能设计：并行派单（test-fanout）

## 1. 模块职责

- `server/ops.mjs`：`runTestCases` 只做「选用例 → 分派」。grouped 分支保持原样；
  fanout 分支走 `runTestCasesFanout`（每条用例一个 run + 一条报告），护栏与值域由 `normalizeMaxParallel` 单点校验。
- `server/agent.mjs`：不动。`startAgentRun` 本来就是「创建任务 + spawn 子进程 + 立即返回」，
  连续调用 N 次即 N 个并行进程——fan-out 只是把「调用一次」改成「调用 N 次」。
- `server/cli.mjs`：`settleCliDispatch` 从「等一个 run」升级为「等一组 run」，
  仍复用 `waitForAgentRun` 的有界轮询。
- `server/{http,mcp}.mjs`：只做参数装配，把 `fanout` / `maxParallel` 透传给 `ops`，不补默认值。

## 2. 关键规则

**为什么默认 grouped**：`runTestCases` 是三入口共用的既有能力，`delivery-gate` / `acceptance`
都依赖它落下的报告。默认改 fan-out 会同时改变 run 数量、CLI 等待语义与下游的自定义脚本行为，
属于不必要的行为面扩张。因此并行是**显式开关**（`fanout=true`），缺省行为逐字节保持。

**为什么 fan-out 每用例一个 run 才有意义**：

1. **真并行**：`startAgentRun` 一次 spawn 一个进程；把 N 条用例拼进一条提示词，agent CLI 只会
   顺序执行，且是否真并行完全取决于 agent 自己。拆成 N 个任务后并行由执行器保证（进程级）。
2. **解析面干净**：`finalizeReportsForRun` 用 `parseRunVerdicts` 从**单条 run 的输出**里按用例名匹配结论。
   grouped 时一个 run 的输出要同时承载 N 条结论，任何一条缺失 / 措辞跑偏都会让其它条回落 `blocked`；
   fan-out 下每个 run 只管一条用例，缺失只会影响它自己。
3. **可单独操作**：`agent_run_cancel` / `agent_run_retry` 以 run 为单位。grouped 时取消是整批，
   fan-out 时可以只重跑挂掉的那条用例。

**为什么护栏是「显式拒绝」而不是截断**：本机执行器没有队列——`startAgentRun` 立刻 spawn。
若把 20 条用例截成 4 条执行，剩下 16 条的报告仍会被创建为 `running`，但它们**永远不会被执行**，
表现为「执行中」的假象，且没有任何调度器会来救它们。拒绝调用让调用方自己收窄 `caseIds`，
比留下 16 条假 running 安全得多（与 `scope` / `format` 「禁止静默降级」同一条纪律）。

**缺省 4 / 上限 16 的依据**：本机 agent CLI 是重进程（各自带模型调用），4 条并发是保守起点；
16 是硬上限，防止一次调用把本机打爆。两个值都是命名常量（`DEFAULT_MAX_PARALLEL` /
`MAX_PARALLEL_LIMIT`），调用方可显式覆盖到上限。

**类型校验必须「先卡类型、再判值域」，并且三入口同一把尺子**（缺陷 2 修复）：
早期写法是 `Number(value)` 再判整数，于是 `true` → 1、`"4"` → 4、`[1]` → 1 都被隐式放过；
而 MCP 用 zod `z.number()` 在协议层就把非 number 拦成 SDK `-32602`，HTTP / ops 却放行——
同样一个 `maxParallel=true`，三入口结论不同。修复后：

- `normalizeMaxParallel` 先 `typeof value !== 'number'` 拒绝，再判 `Number.isInteger` 与 1..16；
- 校验从 fan-out 分支**提到 `runTestCases` 开头**，所以 `fanout:false` 时非法值同样被拒
  （早期错误：grouped 分支完全不校验，非法 `maxParallel` 被静默忽略）；
- CLI 侧补 `parseMaxParallelCli`：argv 天然是文本，只接受规范十进制整数字面量
  （`/^\d+$/`），`1.5` / `0x10` / `1e1` / 空串 / 带空白一律 `VALIDATION_FAILED`，再交给
  `normalizeMaxParallel` 判值域；
- MCP 侧把 schema 从 `z.number()` 改成 `z.unknown()`，让非 number 走进 handler，
  由 `mcpValidate` 统一转成 `isError + VALIDATION_FAILED`，不泄漏 SDK `-32602`
  （与决策 31/35 对 `scope` / `format` 的处理同一条纪律）。

**重试 = 一次新的执行，用例报告必须随 child run 刷新**（缺陷 1 修复）：
`agent_run_retry` 本来只建 child run，父 run 上的用例报告仍停在旧的 `error`——
「可单独重试」在 UI / 门禁上看不出效果，验收报告还会一直按旧结论算。
修复放在 `store.retryAgentRun`：建 child run 后，查父 run 关联的每条 `test_reports`，
为每条用例**随 child run 新开一条 `running` 报告**。这里选「新开一条」而不是「原地 rebind 父报告」，
因为：

1. 回归闭环的既有口径是**一次执行 = 一行**（R6），原地改写会丢掉失败那次的历史；
2. child run 落终态时 `finalizeReportsForRun` 只扫自己 `run_id` 下的 `running` 报告，
   新开的报告天然被它收尾，无需给重试单独写一条收尾路径；
3. 验收报告按「用例最近一条报告」取结论，新报告 id 更大，自动落到重试结果上；
4. 父 run 若本就不带用例报告（普通 agent 任务），循环体为空，不会凭空造报告。

「建 child run + 随 child 开报告」用 `withoutBump` 合并，仍只递增**一次** revision
（与 `finishAgentRun` 的「收尾任务 + 收尾报告」同款）。

## 3. 返回结构

```jsonc
// grouped（缺省，向后兼容）
{ "mode": "grouped", "node": {...}, "kind": "regression", "run": {...}, "reports": [...] }

// fanout
{
  "mode": "fanout",
  "node": {...},
  "maxParallel": 4,
  "runs": [ {...}, {...} ],                 // 每条用例一个 agent 任务
  "reports": [ {...}, {...} ],              // 与 runs 一一对应
  "tasks": [ { "caseId": 1, "name": "A", "kind": "regression", "runId": 10, "reportId": 3 } ]
}
```

`tasks[]` 是帮调用方把 case ↔ run ↔ report 串起来的便利视图，避免自己按顺序对齐数组下标。

## 4. 关键取舍 / 约束

- **报告仍挂用例所属节点**：`store.createTestReport(c.nodeId, ...)`；fan-out 只在**节点内**展开用例
  （`listTestCases(node.id)`），不跨节点，所以归属不会被并行打乱。
- **不做进程级限流**：本轮的 `maxParallel` 只是**调用级的准入护栏**，不是调度器；
  并发上限全交给调用方自觉。真正的排队 / 背压留给后续调度层（见下）。
- **CLI 串行等待不削弱并行**：`waitForAgentRun` 是纯轮询 `store.getAgentRun`，
  不吃 agent 槽位；N 个 run 在 spawn 后已经并行跑着，逐个等待只影响 CLI 返回时刻。
- **`release check` 暂不 fan-out**：`runReleaseChecks` 目前也把检查用例合成一段提示词，
  但它与上线清单是同一个提示词的上下文（要有清单才能判定），拆分需要先定义「一条检查用例：
  一份清单切片」的语义，本轮只预留——`fanout` 是 `runTestCases` 的参数，`release_check` 的
  schema 不变，后续按同样模式加即可。
- **非目标里的调度器**：若后续要支持「选 100 条用例、并发 4」，那时引入的是任务队列而不是
  提高 `MAX_PARALLEL_LIMIT`，因为执行器必须能在前一条终态后拉起下一条。

## 5. 关联章节

- 回归测试闭环：`../regression-loop/design.md`（报告状态机 R5 / 派单自动收尾 R5.1 / 分桶 R6）
- 接口表：`docs/design/04-api.md`「回归测试闭环」段
- 接口示例：`docs/api.md`
- 测试策略：`docs/design/08-testing.md`（单测分组：`test/test-fanout.test.mjs`）

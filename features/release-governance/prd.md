# 功能：上线治理（上线配置 / 上线 SQL / 上线检查清单）

- 代码：`server/db.mjs`（release_items 表）、`server/store.mjs`（上线项读写 + 清单聚合）、`server/ops.mjs`（runReleaseChecks / composeReleaseCheckPrompt / renderReleaseChecklistMd）
- 入口：HTTP（`/api/nodes/:id/release-items`、`/release-items/upsert`、`/release-items/reorder`、`/api/release-items/:rid`、`/release-checklist`、`/release-checks`）· CLI（`release item|checklist|check`）· MCP（`release_item_*` / `release_checklist` / `release_check`）
- 主设计文档：`../../docs/design.md` §4.15（数据模型）；`../../docs/design/04-api.md`（接口表）

## 1. 目标

补齐「需求 → 概要设计/文档 → 回归测试 → 上线治理」的最后一段：
把上线要做的**配置变更 / SQL / 检查项**结构化成清单，把上线前的**代码检查 / 业务检查 / 上线检查**接到已有的 agent 派单链路，
让上线就绪与否变成一个可查询、可回归、可贴进上线单的确定结论。

## 2. 需求点

- R1 上线项挂在任意节点上（项目 / 需求 / 子需求 / 任务组 / 子任务 / 缺陷），同节点内**按名唯一**。
- R2 上线项字段：名称、类型 `kind`、内容 `content`、回滚 `rollback`、状态 `status`、必做 `required`、排序 `sort`。
  `kind = config`（上线配置）/ `sql`（上线 SQL）/ `check`（上线检查）。
- R3 状态值域 `pending / ready / done / blocked / skipped`，必做项只有 `done` / `skipped` 才不算阻塞。
- R4 按名 `upsert` 幂等（与文档 / 测试用例 upsert 语义一致）：已存在则更新内容与状态，返回 `created` 标记。
- R5 上线检查清单：按节点（`self` / `subtree`）聚合上线项的完成度、按类型分布、就绪结论与阻塞项；
  就绪 = 必做项全部 `done`/`skipped` **且** 全部启用中的 `code_check` / `biz_check` / `release_check` 用例最近一次结论为 `pass`
  （只有上线项 done 不代表能上线——登记在册却从没跑 / 最近失败的检查用例同样是阻塞）；
  两类阻塞分列 `blockers`（必做上线项）/ `caseBlockers`（检查用例）；
  **既无必做项也无检查用例时 `ready=null`**（不用 `false` 冒充未就绪；但有用例没跑不能报 `null`，那会被当成不适用而不阻塞）。
- R6 上线前置检查执行：把上线清单 + 已登记的 `code_check` / `biz_check` / `release_check` 用例拼成提示词派单给 agent，
  并为每条检查用例开 `running` 报告；`dryRun` 只回将要检查的内容，不派单、不落库。
- R7 审计：所有写入 `revision` +1，并记录 `created_by` / `updated_by`（user / ai / cli / import / mcp）。

## 3. 非目标（首版）

- 不自动执行上线 SQL（只登记 + 检查；真正执行仍在人的上线流程里）；
- 不接入上线审批流 / 定时上线窗口；
- 不新增专用检查执行器——代码检查 / 业务检查 / 上线检查统一走既有 agent 派单链路（复用 `test_cases` 的 kind 扩展轴）。

## 4. 验收标准

- `test/release-item.test.mjs`：上线项 CRUD、按名唯一与 upsert 幂等、`kind` / `status` 筛选、`includeOptional`、
  排序、随节点级联删除、revision 语义；清单聚合（就绪结论、阻塞项、无必做项 `ready=null`、`scope=subtree`、`blocked` 计数）；
  检查用例纳入（必做项全 done 但用例未跑 → 未就绪、历史 pass 不掩盖后来的 fail、停用不阻塞、running 单列、只有用例时空态不再是 null）；
  编排层 `dryRun`（拼清单 + 只挑 code/biz/release_check 用例、caseIds 过滤）与 markdown 渲染。
- `test/http.test.mjs`：全链路（upsert → 清单 → 回写 done → 就绪）、重名 409 `RELEASE_ITEM_NAME_EXISTS`、dryRun、清单 md。
- `test/run-finalize.test.mjs`：`release check` 非 dry-run 的**进程级**收尾（真实 CLI 子进程 → run 终态 + 检查报告回写）；
  清单 `done` / `skipped` 分列口径；upsert 部分字段不清空其余；名称 trim 唯一性与大小写口径；`scope=subtree` 联动。
- `test/db.test.mjs`：新库建表 + 老库迁移补表补索引。
- `npm test` 全绿；三入口 1:1；文档同步更新（本目录 + `docs/design/02-data-model.md` + `docs/design/04-api.md` + `docs/api.md` + `features/README.md`）。

# 功能：代码推送门禁（登记提交是否真的到了远程）

- 代码：`server/git.mjs`（`commitPushState`）、`server/ops.mjs`（`getNodePushGate` / `renderPushGateMd` / `TOOLS`）、`server/{http,cli,mcp}.mjs`
- 入口：HTTP（`/api/nodes/:id/push-gate`）· CLI（`push gate <ref>`）· MCP（`commit_push_gate`）
- 主设计文档：`../../docs/design.md` §4；相邻功能：`../commit-registry/`（提交登记）、`../branch-track/`（分支合并追踪）、`../delivery-gate/`（交付门禁）

## 1. 目标

研发工作流的收尾动作是「提交并 push」。但 TaskBoard 现在只登记「这条提交属于哪个节点」
（`commit_add`），**不回答「它到底 push 了没有」**——本地提交、忘记 push、push 到一半失败，
在任务板上和「已推送」长得一模一样。于是评审 / 交付时只能靠人去 git 里翻。

本功能补上这段判定：对一个节点（含子树）下**已登记**的提交，逐条判断是否已经到达远程，
聚合成一个可查询、可贴进 issue 的结论。它回答一个问题：
**这份需求关联的代码，是否都已经进远程仓库了。**

统一口径：`ready=true` 才表示「登记提交全部已推送」；`ready=null` 表示**没有可判定的提交**
（不是「未推送」）；`ready=false` 表示**至少有一条没到远程，或状态不可判定**。

## 2. 需求点

- R1 门禁挂在任意节点上；`scope=self` 只判本节点登记的提交，`scope=subtree` 纳入子树。
- R2 判定单位是**已登记的 commit**（`commits` 表），按 `(repo, sha)` 去重，回填来源节点，
  与 `node_tracks` 的去重口径一致——同一提交在多个节点登记不该被当成多条。
- R3 单条提交三态：
  - `pushed`：远程存在，且本机存在包含该提交的 remote-tracking ref（`refs/remotes/*`）；
  - `not_pushed`：远程存在，但没有任何 remote-tracking ref 包含它；
  - `unknown`：无法判定（未登记仓库 / 本地路径无效 / 无远程 / 本地解析不出该 sha / git 执行失败）。
- R4 `unknown` **不算通过**：它和 `not_pushed` 一样进入阻塞项，但用不同的 `reason` 区分，
  避免把「没配仓库」伪造成「已推送」或笼统的「未推送」。
- R4a `reason` 必须是**稳定且可行动**的枚举值，至少区分：远程无该提交（`no-remote-ref-contains`）、
  未登记仓库（`repo-not-registered`）、未登记本地路径（`repo-path-unset`）、
  本地路径无效（`repo-path-missing`）、本机 git 不可用（`git-unavailable`）、
  未配置远程（`no-remote`）、sha 本地不存在（`sha-not-found`）、其它 git 失败（`git-error`）。
  每个值对应一个明确修复动作，**不得**把多种失败笼统归成一个 reason；
  `detail` 使用真实错误信息（`error.message`），便于直接定位。
- R5 顶层三态：全部 `pushed` → `ready=true`；存在任一 `not_pushed` 或 `unknown` → `ready=false`；
  scope 内没有任何已登记提交 → `ready=null`（沿用 `ready=null` 的空态口径，不用 `false` 冒充未推送）。
- R6 输出 `items`（逐条提交 + 来源节点 + 依据 refs）/ `blockers`（未通过项 + 原因）/
  `totals`（提交与三态计数），并支持 `format=md` 直接贴进 issue / 评审记录。
- R7 只读聚合：**不写库、不动 revision**；也不自动 `fetch`，只读本机已有 ref
  （与 `branch-track` 同口径，避免网络与权限副作用）。

## 3. 非目标（首版）

- 不自动 `git push`：门禁是**结论**，不是执行器；推送仍由开发者 / agent 自己完成。
- 不自动 `git fetch`：只读本地 ref。代价是「别人推送但本机未 fetch」可能读成未推送，
  这是刻意的（见 design R5）——门禁不制造网络副作用。
- 不校验「推到了哪个分支」的正确性（如该进预发却推到了 feature），那是 `branch-track` 的职责。
- 首版**不改** `delivery_gate` 的来源集合；该收口已由决策 38 完成——`push` 现为交付门禁的
  第四个来源，未推送 / 无法判定都会阻塞交付（见 `../delivery-gate/`）。

## 4. 验收标准

- `test/push-gate.test.mjs`：已推送 / 未推送 / 无远程 / 未登记仓库 / 子树聚合与去重 /
  空态 `ready=null` / `unknown` 阻塞但不冒充通过 / markdown 渲染（含表格单元格转义）/
  纯读不产生 revision / 能力清单登记。
- `reason` 契约回归（`test/push-gate.test.mjs` 的 D1/D2 用例）：未登记本地路径 →
  `repo-path-unset`；路径无效 → `repo-path-missing` 且 `detail` 带真实路径；
  本机 git 不可用 → `git-unavailable`（不再误报成路径问题）；
  四类可行动 reason 互不串味。每条断言在旧实现（catch 一律标 `repo-path-missing`）上都会失败。
- 三入口 1:1：HTTP `?scope=`、CLI `--scope`、MCP schema 字段集一致；非法 `scope` / `format`
  一律 `VALIDATION_FAILED`（MCP 返回 `isError`，不泄漏 SDK `-32602`）。
- `npm test` 全绿；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/api.md`
  + `docs/design/08-testing.md` + `docs/design/09-decisions.md` + `features/README.md`）。

# 功能设计：工作区准备

## 模块位置

- `server/git.mjs`：`revParse` / `localBranchSha` / `listWorktrees` / `worktreeOccupancy` /
  `addWorktree` / `removeWorktree` / `deleteLocalBranch`
- `server/store.mjs`：`unit_repos` CRUD（`listUnitRepos` / `addUnitRepo` / `updateUnitRepo` / `deleteUnitRepo`）
- `server/ops.mjs`：`setupWorkspace`（编排）/ `getWorkspacePrompt`（纯读）/ `cleanupWorkspace` +
  纯函数 `renderBranchName` / `renderWorktreePath` / `composeWorkspacePrompt`
- `server/{http,cli,mcp}.mjs`：三入口 1:1（MCP 工具 `unit_repo_*` / `unit_setup` / `unit_prompt` / `unit_cleanup`）

## 设计要点

- **分支命名**：`config.branchTemplate` 渲染，变量 `{base_branch}` 与 `{slug}`；`slug` 为空用 `n{id}`
- **派生基线**：创建时取**当前子需求分支的最新提交**（不是登记时刻的快照），避免与集成分支脱节
- **多仓库**：一条分支名覆盖所有登记仓库，`unit_repos` 每仓库一行记录各自的 `worktree_path`
- **提示词即开工包**：把 AI 开工所需上下文一次给全（节点上下文 + 工作区路径 + 分支基线 +
  文档清单 + 命令清单 + 提交/合并约定），减少反复询问
- **清理策略**：默认保留（合并后 Diff 入口仍可用）；清理时先判断分支是否已并入集成分支再删

## 关联

- 设计文档 §7.10（工作区准备）、§4.12（unit_repos）、§6
- 决策 #23（工作区由工具创建）、#24（工作单元支持多仓库）

## 注意

所有 git 命令失败都要把 stderr 放进错误 `details`（§9 的 `GIT_FAILED`）。
`worktree add` 有副作用但可逆（`worktree remove`），是否算破坏性操作以 `cleanup` 为准（需 `confirm`）。

## 关键规则（实现后回填）

**R1 基线的判定用「tip 相等」，不是「包含」**：`addWorktree` 若发现同名分支已存在，
只认它的 tip **恰好等于**基线当前 tip。分支是基线的祖先（更旧）同样属于基线不一致——
复用会让开发者从过期代码开工；分支领先基线则代表有未合并成果。两者都抛
`BRANCH_EXISTS_DIFFERENT_BASE`，交由人工显式确认，不静默复用。
（幂等场景不走这条：创建过工作区后路径已存在且同分支，会直接 `alreadyExists` 跳过。）

**R1.1 基线校验必须前置到任何 git 写操作之前（D1 回归点）**：基线一致性由只读的
`checkWorktreePlan()` 判定，`addWorktree()` 先拿它的结论再决定要不要动手。
早期实现是「先 `git worktree add`、再比对 tip」，于是**首次调用虽然报错，worktree 已经建了出来**；
重试时 `worktreeOccupancy` 判定为 `same` → 直接 `alreadyExists` → **整段基线校验被跳过**，
「不静默复用」形同虚设，开发者会挂到错误基线的分支上开工。
因此本规则是硬约束：**拒绝时零副作用**（不建 worktree、不建分支、不回填属性、不动 revision），
并有「拒绝后重试仍拒绝」的 UT 锁定。

**R2 路径比较必须 realpath 归一**：`git worktree list --porcelain` 回报的是**符号链接解析后**的路径
（macOS 上 `/tmp/...` → `/private/tmp/...`），直接比字符串会把「已存在的同一 worktree」
判成「路径被占用」，于是幂等复用变成 409、清理又找不到目标。`samePath()` 两侧都做
`realpathSync`，失败才退回 `path.resolve`。

**R3 `dryRun` 是纯规划**：只渲染分支名与路径、检查仓库是否可解析，**不碰本机 git、不落库、不动 revision**——
与 `readiness` / `acceptance_report` 同一条「让 AI 可以放心预演」的纪律。

**R4 组合写入 = 一次 revision**：回填 `unit_repos`（分支 / 路径）与节点属性（`branch` / `base_branch`）
用 `store.withoutBump` 包起来再统一 `bumpRevision()`，避免一次操作把 revision 推高多次。

**R5 清理默认保留、未并入基线不删**：`cleanupWorkspace` 需 `confirm`（与删除/移动同口径）。

**删分支的判定必须相对「声明的基线」，不能用 `git branch -d`（D2 回归点）**：
`branch -d` 比较的是「是否已并入**当前 HEAD**」，而清理时 HEAD 往往是 `main` 之类，
与声明的基线无关。实测三种 HEAD 状态会给出三种结论，其中最坏的一种是
**「分支已并入 HEAD(main) 但未并入基线」→ 分支被删**，直接丢掉未合并的开发成果；
反向「已并入基线但基线领先 HEAD」又会被保守拒绝。两种误判同源。
现改为显式 `git merge-base --is-ancestor <branch> <baseBranch>`，并入才删，
未并入回报 `branchNote: 'branch-not-merged'`；显式保留分支时回报 `kept_by_request`。
重复调用幂等（worktree 已移除 / `worktree_path` 已清空都按「已移除」处理）。

> **夹具纪律**：与 HEAD 状态相关的用例，UT 夹具必须让 **HEAD ≠ 基线**。
> 早期夹具让 HEAD(main)、基线、工作分支停在同一个 commit，`branch -d` 与
> `merge-base --is-ancestor <branch> <base>` 结果完全一致，「并入 HEAD 但未并入基线」
> 在几何上无法表达——383 条全绿也照样漏掉了 D2。

**R5.1 `removeBranch: false` 必须真的能表达**：HTTP / MCP 用布尔字段没问题，
但 CLI 的 `parseArgs` boolean 选项无法表达「显式 false」（`--x false` 把 false 当位置参数、
`--x=false` 直接抛错）。因此 CLI 改用正向开关 **`--keep-branch`**，
而不是形同虚设的 `--remove-branch false`（D3 回归点）。

**R6 MCP 的 `confirm` 用 `.catch(undefined)` 兜底**：`z.boolean()` 会把「没传 confirm」
拦成 SDK `-32602`，泄漏协议错误。改用 `z.boolean().catch(undefined)`——
对外 schema 仍是 required boolean，但缺失值下沉到 handler，由 `mcpValidate` 归一成
`isError + CONFIRM_REQUIRED`，与 HTTP / CLI 的拒绝语义一致。

**R6.1 `dryRun` 要与真跑同结论（D4）**：预演的价值在于「可信」，因此 dryRun 走的是
与真跑**同一个只读探查** `checkWorktreePlan()`，能报出路径占用（`path-occupied`）
与基线不符（`base-mismatch`），而不是一律乐观返回 `ok:true`。零副作用与可信预演两者都要。

**R6.2 纯 no-op 不 bump revision（D5）**：完全相同的重复 setup（`alreadyExists`）不回填任何字段，
因此也不递增 revision——仓库既有约定是「无变化不 bump」，避免制造无意义的变更噪声。
注意这不违反「一次操作只 +1」：真正有变化时仍是恰好 +1。

**R7 只有 `group` / `task` 是工作单元**：项目 / 需求 / 子需求有自己的分支语义（分支组、需求分支），
不参与工作区派生。`addUnitRepo` 与 `setupWorkspace` 都做类型校验，给出 `details.allowed`。

# 功能设计：代码集成（显式合并）

## 模块位置

- `server/git.mjs`：`previewMerge`（`merge-tree --write-tree --name-only`）、`mergeBranch`、`revParse` / `mergeBase`
- `merges` 表（§4.11，已在 `db.mjs` 建表）
- `unit_repos` 表（§4.12）：决定工作单元覆盖哪些仓库
- `server/store.mjs`：`merges` CRUD（`listMerges` / `addMerge` / `confirmMerge` / `abortMerge`）
- `server/ops.mjs`：`precheckMerge`（纯读）/ `runMerge`（显式合并）/ `listMergeRecords` / `confirmMergeRecord` / `abortMergeRecord`
- `server/{http,cli,mcp}.mjs`：三入口 1:1（`merge_precheck` / `merge_run` / `merge_list` / `merge_confirm` / `merge_abort`）

## 设计要点

- **预检**：`git merge-tree --write-tree --name-only <target> <source>`（纯内存三方合并）。
  exit=1 即冲突；stdout 第一行是 tree oid，之后是冲突文件路径（跳过 `Auto-merging` / `CONFLICT` 说明行）；
  不写工作区、不建 commit
- **执行合并**：在目标分支上 `git merge --no-ff <source_branch>`；失败则报告 stderr 并保持原状
- **一次合并 = 按仓库各写一行 `merges`**（`source_branch` / `target_branch` / 三个 sha / `state`）
- **状态机**：`precheck_conflict` →（冲突处理后）`resolved`；直接成功 → `merged`；放弃 → `aborted`
- **失败语义**：破坏性入口必须 `confirm`；source/target 缺失 → `BRANCH_NOT_FOUND`；
  仓库无本地路径 → `REPO_PATH_MISSING`；成功/冲突/失败逐仓库分别回报

## 关键规则（实现后回填）

**R1 预检必须只读**：`precheckMerge` 只执行 `merge-tree` 与 ref 读取，不 checkout、不 merge、不落库。
它的输出用于 API/CLI/MCP 展示，也是 `runMerge` 的前置判断。

**R2 每次合并尝试落一行**：`runMerge` 对每个参与仓库写一行 `merges`——成功 `merged`，
冲突 `precheck_conflict`，`merge_sha` 只在实际合并后回填。记录是审计与冲突队列的共同来源。

**R3 `confirm` / `abort` 不直接改分支**：`confirm` 只回填 `merge_sha` 并置 `resolved`（表示本地已应用）；
`abort` 只置 `aborted`（不改任何分支）。真正的冲突应用由人或 AI 在本地完成。

**R4 `merge-tree` 输出解析必须带 `--name-only`**：Git 2.39+ 的裸 `--write-tree` 会输出
`100644 <oid> <stage>\tpath` 的 stage 行；直接按行取文件名会把 oid/阶段一并写进 `conflict_files`。
同时 `gitTry` 在非零退出时也要透传 stdout——`merge-tree` 的冲突清单正是写在 stdout 上。

## 关联

- 设计文档 §7.11（代码集成与合并）、§4.11（merges 表）、§4.12（unit_repos）、§6
- 决策 #20（合并为显式操作）、#22（merges 表）、#24（工作单元支持多仓库）

## 注意

合并会改本机分支，属**破坏性**操作：HTTP 需 `confirm: true`，CLI 需 `--confirm`；
预检不在此列（无副作用）。v1 **不 push、不创建 MR**（§2.2）。

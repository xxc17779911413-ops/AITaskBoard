# 功能设计：代码集成（显式合并）

## 模块位置

- `server/git.mjs`：`previewMerge`（`merge-tree --write-tree --name-only -z`）、`mergeBranch`（成功后恢复原 HEAD）、`revParse` / `mergeBase`
- `merges` 表（§4.11，已在 `db.mjs` 建表）
- `unit_repos` 表（§4.12）：决定工作单元覆盖哪些仓库
- `server/store.mjs`：`merges` CRUD（`listMerges` / `addMerge` / `confirmMerge` / `abortMerge`）
- `server/ops.mjs`：`precheckMerge`（纯读）/ `runMerge`（显式合并）/ `listMergeRecords` / `confirmMergeRecord` / `abortMergeRecord`
- `server/{http,cli,mcp}.mjs`：三入口 1:1（`merge_precheck` / `merge_run` / `merge_list` / `merge_confirm` / `merge_abort`）

## 设计要点

- **预检**：`git merge-tree --write-tree --name-only -z <target> <source>`（纯内存三方合并）。
  exit=1 即冲突；stdout 是 NUL 分隔记录：首条 tree oid，随后是冲突路径，空记录后进入说明区；
  用分隔符而不是文本前缀判断，天然支持 `conflict.txt` / `ConflictPane.vue` / `Auto-merging.md` / 非 ASCII 路径；
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

**R4 `merge-tree` 输出解析必须用 `--name-only -z`（N2/N3 回归点）**：Git 2.39+ 的裸 `--write-tree`
会输出 `100644 <oid> <stage>\tpath` 的 stage 行；非 `-z` 输出还会对非 ASCII 路径做 C 风格引号转义。
改按 NUL 分隔解析后，冲突路径原样 UTF-8 落库，且不需要猜「哪些行是说明行」——
`conflict.txt` / `ConflictPane.vue` / `Auto-merging.md` 这类文件名不会因前缀匹配被误删。
同时 `gitTry` 在非零退出时也要透传 stdout——`merge-tree` 的冲突清单正是写在 stdout 上。

**R5 `confirm` 只服务冲突行（N4 回归点）**：`merged` 是已完成的合并尝试，不能再 `confirm`
降级成 `resolved`；`aborted` 同样不可确认。冲突行若调用方没有显式给 `mergeSha`，
`merge_sha` 保持为空，不拿预检时的 `target_sha` 冒充「本地已应用后的提交」，避免审计字段误导。

**R6 合并成功恢复原 HEAD（已知风险 #2 / N5 回归点）**：`mergeBranch` 为执行 `merge --no-ff` 必须
checkout 到集成分支，但会在成功后恢复发起前的 HEAD。原位置用 `symbolic-ref -q HEAD` 区分
attached/detached，并用 `rev-parse HEAD` 记录具体 sha：attached 恢复分支名，detached 用
`checkout --detach <sha>` 恢复；`restoredHead` 对 attached 报分支名、对 detached 报 sha；
冲突时不切回，保留现场供人工/AI 处理。

**R7 冲突详情 / resolve 不自动改分支**：`getMergeConflicts` 用记录中的 base/target/source sha
读取三方内容；`resolveMergeConflicts` 以 target 版本为「当前」生成 unified patch，把最终内容与
`contentHash` 写入 `merges.resolved_files`。`writeToWorktree:true` 时只写入已登记的
`unit_repos.worktree_path`，且路径必须位于 worktree 内；分支与 `state` 在 `confirm` 之前保持不变。

## 关联

- 设计文档 §7.11（代码集成与合并）、§4.11（merges 表）、§4.12（unit_repos）、§6
- 决策 #20（合并为显式操作）、#22（merges 表）、#24（工作单元支持多仓库）

## 注意

合并会改本机分支，属**破坏性**操作：HTTP 需 `confirm: true`，CLI 需 `--confirm`；
预检不在此列（无副作用）。v1 **不 push、不创建 MR**（§2.2）。

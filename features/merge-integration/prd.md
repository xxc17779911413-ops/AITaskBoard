# 功能：代码集成（显式合并）

## 所属计划

计划 4。

## 需求

- 工作单元（`group` / `task`）分支合并回**子需求集成分支**，由按钮 / CLI **显式触发**（不自动）
- 合并前用 `git merge-tree` 做**内存三方预检**（不碰工作区、不落分支）
- 预检有冲突 → 落 `merges` 行（`state = precheck_conflict` + 冲突文件）→ 进入冲突处理
- 预检无冲突 → 本机执行 `git merge --no-ff <source_branch>`（目标为集成分支，**不 push**）→ 落 `merges` 行（`merged` + `merge_sha`）
- 预检/合并的仓库范围来自工作单元登记的 `unit_repos`；`repo` 可显式收窄到单个仓库
- 全程只读 + 本地写；不 push、不动远端分支
- 冲突时落 `precheck_conflict` 后可由 `confirm` 置 `resolved` 或 `abort` 置 `aborted`
- 冲突行可读三方内容（base / ours / theirs）并写回处理结果；写回产出可 `git apply` 的统一补丁，可选写入已登记 worktree
- 冲突文件清单必须原样可用：不能用文本前缀猜「说明行」，非 ASCII / 含特殊字符的路径也必须落成真实路径（N2/N3）
- `confirm` 只用于冲突行；已 `merged` 的尝试不得被降级为 `resolved`，未显式给 `mergeSha` 时不得拿预检 `target_sha` 冒充（N4）
- `merge run` 从第三分支发起时，成功后应恢复原 HEAD，避免把用户留在集成分支

## 接口（设计文档 §6）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/nodes/:id/merges/precheck` | 合并预检（merge-tree，不落库、不合并）|
| POST | `/api/nodes/:id/merges` | 显式合并：`{repo?, confirm, dryRun?}` → `{merged[], conflicts[], failed[]}` |
| GET | `/api/merges?nodeId=&state=` | 合并记录列表（含待处理冲突）|
| POST | `/api/merges/:mid/confirm` | 确认合并完成 → 回填 `merge_sha`，`state = resolved` |
| POST | `/api/merges/:mid/abort` | 放弃本次合并 → `aborted`（不改任何分支）|

## 验收标准

- 预检发现冲突时**不修改工作区、不落分支**，返回 200 + 冲突清单
- 合并成功写 `merges` 行并回填 `merge_sha`
- 分支不存在 → 400 `BRANCH_NOT_FOUND`；未登记仓库 → 400 `REPO_NOT_REGISTERED`
- HTTP 侧破坏性调用需 `confirm: true`，CLI 侧需 `--confirm`
- 冲突与成功都必须可追溯：`merges` 行含 source/target/三方 sha/state/merge_sha/conflict_files
- `precheck_conflict` 行含 `resolved_files`（path / content / contentHash / wroteWorktree），供确认前审计与复查
- 冲突确认走 `POST /api/merges/:mid/confirm`；放弃走 `abort`，两者都不直接改分支
- 冲突清单解析以 `merge-tree --write-tree --name-only -z` 的 NUL 分隔为界，`conflict.txt` / `ConflictPane.vue` / `Auto-merging.md` / `中文.txt` 都不得被丢弃或转义
- detached HEAD 发起 `merge run` 时也恢复到原 sha；`restoredHead` 对 attached 报分支名、对 detached 报 sha（N5）

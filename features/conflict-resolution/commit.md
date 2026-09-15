# 冲突检测与处理功能提交记录

> 状态：**已实现**（计划 4）。

- docs(conflict-resolution): 建立功能文档 —— prd（需求 + 接口表 + 验收标准）、design（冲突块解析 + MergeView + 三入口同源）
- feat(conflict-resolution): 冲突详情与写回闭环——新增 `getMergeConflicts`（按 base/target/source sha 读三方内容）与 `resolveMergeConflicts`（最终内容 + contentHash + 可 `git apply` 的统一补丁；可选写入已登记 worktree，含路径越界防护）；`merges` 表补 `resolved_files`（老库幂等迁移）；三入口 1:1（HTTP `GET /api/merges/:mid/conflicts` + `POST /resolve`、CLI `conflict show|resolve`、MCP `merge_conflicts|merge_resolve`）
- test(conflict-resolution): 真 git 回归——三方 base/ours/theirs 读取、resolve 产出补丁并 `git apply` 成功、`contentHash` 确定性、resolve 不改分支也不自动置 resolved、worktree 写入与未登记拒绝
- fix(conflict-resolution): 按独立验收返工 N6–N8——① **N6（严重）** 补丁生成不再按行前缀改头，改用 `a/<path>` / `b/<path>` 临时结构与空 prefix 直接产出正确头，内容行以 `-- ` / `++ ` 开头时 apply 不再失败/写坏 ② **N7（严重，安全）** worktree 写入增加 realpath/lstat 逐级校验，拒绝目标或父目录符号链接逃逸 ③ **N8** 内容与目标一致时返回 `changed:false`，不再产出会被 apply 拒绝的空补丁。补内容前缀型 apply、目标/父目录符号链接、无变更三类回归 UT
- fix(conflict-resolution): 收口 N9a/N9b——① **N9a（回归）** `ensureWorktreePathSafe` 对不存在的路径段直接停止 `realpath`，父目录缺失时写入恢复成功，所有拒绝保持 `AppError` 稳定码（不泄漏裸 `ENOENT`）② **N9b** `unifiedFilePatch` 覆盖 `before === null` 的 new-file 语义并处理删除语义，产出 git 原生 new/delete 补丁；补「父目录不存在写入 worktree」「target 删除后 resolve 写回并 apply」两类回归

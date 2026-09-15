# 冲突检测与处理功能提交记录

> 状态：**已实现**（计划 4）。

- docs(conflict-resolution): 建立功能文档 —— prd（需求 + 接口表 + 验收标准）、design（冲突块解析 + MergeView + 三入口同源）
- feat(conflict-resolution): 冲突详情与写回闭环——新增 `getMergeConflicts`（按 base/target/source sha 读三方内容）与 `resolveMergeConflicts`（最终内容 + contentHash + 可 `git apply` 的统一补丁；可选写入已登记 worktree，含路径越界防护）；`merges` 表补 `resolved_files`（老库幂等迁移）；三入口 1:1（HTTP `GET /api/merges/:mid/conflicts` + `POST /resolve`、CLI `conflict show|resolve`、MCP `merge_conflicts|merge_resolve`）
- test(conflict-resolution): 真 git 回归——三方 base/ours/theirs 读取、resolve 产出补丁并 `git apply` 成功、`contentHash` 确定性、resolve 不改分支也不自动置 resolved、worktree 写入与未登记拒绝

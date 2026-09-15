# 代码集成功能提交记录

> 状态：**已实现**（计划 4）。

- docs(merge-integration): 建立功能文档 —— prd（需求 + 接口表 + 验收标准）、design（设计要点 + 状态机 + 注意事项）
- feat(merge-integration): 显式合并闭环——`merges` store CRUD（状态机 / conflict_files JSON / 审计字段）+ ops（`precheckMerge` 只读、`runMerge` 逐仓库 `merge --no-ff` 并落 merged/precheck_conflict、list/confirm/abort）+ 三入口 1:1（HTTP 5 路由 / CLI `merge precheck|run|list|confirm|abort` / MCP 5 工具并登记能力清单）；`previewMerge` 改用 `merge-tree --write-tree --name-only`，并修复 `gitTry` 非零退出丢失 stdout 的问题
- test(merge-integration): 真 git 回归 5 条——merges 状态机 CRUD；冲突预检只读且落 precheck_conflict 不改分支；无冲突合并成功并幂等；缺 confirm / 分支缺失 / 类型非法稳定错误码；另覆盖 workspace-setup N1（保留分支必须保留 attrs.branch，prompt 仍指向真实分支）

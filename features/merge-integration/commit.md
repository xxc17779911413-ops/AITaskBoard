# 代码集成功能提交记录

> 状态：**已实现**（计划 4）。

- docs(merge-integration): 建立功能文档 —— prd（需求 + 接口表 + 验收标准）、design（设计要点 + 状态机 + 注意事项）
- feat(merge-integration): 显式合并闭环——`merges` store CRUD（状态机 / conflict_files JSON / 审计字段）+ ops（`precheckMerge` 只读、`runMerge` 逐仓库 `merge --no-ff` 并落 merged/precheck_conflict、list/confirm/abort）+ 三入口 1:1（HTTP 5 路由 / CLI `merge precheck|run|list|confirm|abort` / MCP 5 工具并登记能力清单）；`previewMerge` 改用 `merge-tree --write-tree --name-only`，并修复 `gitTry` 非零退出丢失 stdout 的问题
- test(merge-integration): 真 git 回归 5 条——merges 状态机 CRUD；冲突预检只读且落 precheck_conflict 不改分支；无冲突合并成功并幂等；缺 confirm / 分支缺失 / 类型非法稳定错误码；另覆盖 workspace-setup N1（保留分支必须保留 attrs.branch，prompt 仍指向真实分支）
- fix(merge-integration): 按独立验收返工 N2–N4——① N2 冲突清单解析改为 `merge-tree --write-tree --name-only -z` 的 NUL 分隔（不再按文本前缀猜说明行，`conflict.txt` / `ConflictPane.vue` / `Auto-merging.md` 不再被误删）② N3 非 ASCII 路径原样 UTF-8 落库（`中文.txt` 不再变成 git 引号转义串）③ N4 `merged`/`aborted` 行拒绝 `confirm`，未显式给 `mergeSha` 时不再拿 `target_sha` 冒充；并顺手处理已知风险 #2：`merge run` 成功后恢复发起前 HEAD，返回值回报 `restoredHead`。补 4 类文件名 + 第三分支 HEAD 恢复回归 UT
- fix(merge-integration): 收口 N5——`mergeBranch` 改用 `symbolic-ref -q HEAD` 区分 attached/detached，并用 `rev-parse HEAD` 记录具体 sha；detached 成功合并后 `checkout --detach <sha>` 恢复，`restoredHead` 对 detached 报 sha。补 detached HEAD 回归 UT

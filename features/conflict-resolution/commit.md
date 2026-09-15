# 冲突检测与处理功能提交记录

> 状态：**已实现**（计划 4）。

- docs(conflict-resolution): 建立功能文档 —— prd（需求 + 接口表 + 验收标准）、design（冲突块解析 + MergeView + 三入口同源）
- feat(conflict-resolution): 冲突详情与写回闭环——新增 `getMergeConflicts`（按 base/target/source sha 读三方内容）与 `resolveMergeConflicts`（最终内容 + contentHash + 可 `git apply` 的统一补丁；可选写入已登记 worktree，含路径越界防护）；`merges` 表补 `resolved_files`（老库幂等迁移）；三入口 1:1（HTTP `GET /api/merges/:mid/conflicts` + `POST /resolve`、CLI `conflict show|resolve`、MCP `merge_conflicts|merge_resolve`）
- test(conflict-resolution): 真 git 回归——三方 base/ours/theirs 读取、resolve 产出补丁并 `git apply` 成功、`contentHash` 确定性、resolve 不改分支也不自动置 resolved、worktree 写入与未登记拒绝
- fix(conflict-resolution): 按独立验收返工 N6–N8——① **N6（严重）** 补丁生成不再按行前缀改头，改用 `a/<path>` / `b/<path>` 临时结构与空 prefix 直接产出正确头，内容行以 `-- ` / `++ ` 开头时 apply 不再失败/写坏 ② **N7（严重，安全）** worktree 写入增加 realpath/lstat 逐级校验，拒绝目标或父目录符号链接逃逸 ③ **N8** 内容与目标一致时返回 `changed:false`，不再产出会被 apply 拒绝的空补丁。补内容前缀型 apply、目标/父目录符号链接、无变更三类回归 UT
- fix(conflict-resolution): 收口 N9a/N9b——① **N9a（回归）** `ensureWorktreePathSafe` 对不存在的路径段直接停止 `realpath`，父目录缺失时写入恢复成功，所有拒绝保持 `AppError` 稳定码（不泄漏裸 `ENOENT`）② **N9b** `unifiedFilePatch` 覆盖 `before === null` 的 new-file 语义并处理删除语义，产出 git 原生 new/delete 补丁；补「父目录不存在写入 worktree」「target 删除后 resolve 写回并 apply」两类回归
- fix(conflict-resolution): 收口 N10/N10b——① **N10（严重）** 单侧缺失补丁不再按整份 patch 行前缀改写，改为只归一首个 `@@` 之前的头区，new-file 内容首行 `++ ` / delete-file 内容首行 `-- ` 不再写坏 ② **N10b** resolve 新增显式删除表达 `{delete:true}` / `{content:null}`，产出 delete-file 补丁并落 `deleted:true`；`content:''` 仍表示保留空文件；三入口 schema / 文档同步
- feat(conflict-resolution): 前端 `ConflictPane.vue` 落地——抽屉检测 `precheck_conflict` → 打开三方内容面板，支持逐文件编辑 / 采纳删除，调用同一 resolve / confirm / abort API；二进制补丁边界显式化（`patches[].binary=true` + note，提醒走写回 / 删除而非 apply）
- fix(conflict-resolution): 收口 N11——ConflictPane 编辑状态抽出 `conflict-state.js`：切文件前回收当前编辑到 `resolvedMap`，`handled` 显式区分未处理与已处理为空，「采纳删除 → 保留内容」恢复删除前草稿而非空串；补「编辑 A → 切 B → 写回」「编辑 → 采纳删除 → 保留内容 → 写回」「未处理 vs 已处理为空」三条多文件回归
- fix(conflict-resolution): 收口 N12——`setDelete` 进入删除/保留态前先 `commitCurrent` 回收当前编辑器草稿；回归从空 map / 未回收草稿起跑，模拟组件真实调用序列，避免再次只锁模块语义

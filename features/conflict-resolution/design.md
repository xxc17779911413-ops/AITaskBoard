# 功能设计：冲突检测与处理

## 模块位置

- `server/git.mjs`（待建）：解析 `merge-tree` 输出、生成补丁
- `merges.conflict_files`（JSON 字段，§4.11）
- `web/src/components/ConflictPane.vue`（待建）：MergeView 逐块处理

## 设计要点

- **冲突块解析**：把 `merge-tree` 输出的 `<<<<<<< / ======= / >>>>>>>` 段落结构化为
  `{ file, blocks: [{ base, ours, theirs, oursStartLine, oursEndLine, theirsStartLine, theirsEndLine }] }`
- **落库**：原始冲突块存 `merges.conflict_files`（JSON）；resolve 时写回合并结果与补丁
- **前端**：`@codemirror/merge` 的 MergeView 提供三栏（或 ours–theirs 两栏 + base 折叠），
  每块「保留当前 / 采用传入 / 手改」；顶部「全部接受当前 / 全部接受传入」与上一个 / 下一个块导航
- **三入口同源**：REST `GET /api/merges/:mid/conflicts` ↔ CLI/MCP `conflict show` / `conflict resolve`
  —— AI 读同样三方数据、写回同样结果

## 关联

- 设计文档 §7.12（冲突处理）、§8.5（ConflictPane）、§4.11、§6
- 决策 #21（冲突在工具内处理 + AI 可写）、#18（CodeMirror MergeView）

## 注意

冲突处理**不自动改分支**；只有显式「确认合并完成」（`confirm`）才回填 `merge_sha`。
补丁默认不落盘，仅在用户选择「写入 worktree」时写到 `unit_repos.worktree_path`。

## 关键规则（实现后回填）

**R1 三方内容按记录 sha 读取**：`getMergeConflicts` 使用 `merges` 行里的 `base_sha` /
`target_sha` / `source_sha` 读取 base / ours / theirs（不是用当前分支 tip 推算）；
add/add、modify/delete 等缺 stage 的场景如实返回 `null`。

**R2 补丁头只在生成阶段构造，不做文本改写（N6 回归点）**：`unifiedFilePatch` 在临时目录下
用 `a/<path>` / `b/<path>` 结构生成 diff，并用 `--src-prefix='' --dst-prefix=''`；
hunk 内容行以 `-- ` / `++ ` 开头也不会被误当头行改写。**禁止**再按行前缀扫描整个 diff。

**R3 worktree 写入必须 realpath/lstat 级校验（N7 回归点）**：只做
`path.resolve` + `startsWith` 会被符号链接绕过。写入前逐级 `lstat`，拒绝目标或任一父目录
是符号链接；目标已存在时用 `realpath` 复核真实落点仍在 `realpath(worktreeRoot)` 内。
不存在的路径段视为安全并停止 `realpath` 校验（N9a）——缺失的路径不可能包含符号链接逃逸；
写入时再由 `mkdirSync` 递归创建缺失父目录。任何拒绝都必须抛 `AppError` + 稳定业务码，
不得漏出裸 `ENOENT`。

**R4 无变更时不产出空补丁（N8 回归点）**：resolve 内容若与目标版本一致，
返回 `changed:false` + `note`，不再给一个下游 `git apply` 会拒绝的空 patch。

**R5 补丁覆盖单侧缺失语义（N9b 回归点）**：`unifiedFilePatch` 必须区分
「目标存在 → 内容变更」「目标不存在（`before === null`）→ 新建」「目标被删除（`after === null`）→ 删除」。
单侧缺失时生成 git 原生 new-file / delete-file 补丁（`--- /dev/null` + `new file mode` 或
`deleted file mode`），使 `git apply` 能在目标分支真实文件缺失时成功应用。

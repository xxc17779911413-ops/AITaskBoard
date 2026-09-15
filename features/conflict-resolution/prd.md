# 功能：冲突检测与处理

## 所属计划

计划 4。

## 需求

- 冲突详情返回每个冲突文件的 **base / ours / theirs** 三方内容与冲突块
- 工具内用 CodeMirror MergeView **逐块**「保留当前 / 采用传入 / 手改」
- 产出：合并后的文件内容 + unified 补丁；可复制 / 下载 / 写入对应仓库的 worktree
- **AI 可通过 CLI / MCP 读三方并写回**（同一能力暴露给三入口）
- 本地应用完成后「确认合并完成」→ 回填 `merge_sha`，`merges.state = resolved`；放弃则 `aborted`（不改任何分支）
- 也可生成「交给 IDE 的提示词」
- 前端 `ConflictPane` 展示 base / ours / theirs 并写回处理结果；二进制补丁边界显式（`binary:true` + 说明），不诱导下游误 apply

## 接口（设计文档 §6）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/merges/:mid/conflicts` | 冲突详情：文件 + 冲突块 + 三方内容 |
| POST | `/api/merges/:mid/resolve` | 写回冲突处理结果 `{files:[{path, content}], asPatch?}` |
| POST | `/api/merges/:mid/confirm` | 确认合并完成 → 回填 `merge_sha`，置 `resolved` |
| POST | `/api/merges/:mid/abort` | 放弃本次合并 → `aborted` |

## 验收标准

- 每个冲突块能定位到文件与行号范围，base / ours / theirs 三方内容完整
- 逐块接受 / 拒绝后产出的结果可转成 unified 补丁，且该补丁能 `git apply` 成功
- `abort` 后**不改变任何分支状态**
- resolve 后 `merges.state` 与 `conflict_files` 正确更新

# 9. 错误处理与边界

> 本文是主设计文档 [`../design.md`](../design.md) 的拆分章节；索引与章节导航见该文件。


| 场景 | 处理 |
|---|---|
| 父子类型非法 / 跨级 | 400，返回允许的父类型 |
| 在叶子节点（`task` / `defect`）下建子节点 | 400，提示该类型为叶子节点 |
| 路径同名歧义 | 409，提示改用 `id` 引用 |
| 同节点内文档重名 | 409 `DOC_NAME_EXISTS`；UI 新增时自动加序号规避 |
| 同节点内测试用例重名 | 409 `TEST_CASE_NAME_EXISTS`（upsert 走幂等覆盖，不报错） |
| 报告终态互转 / 终态回退 running | 409 `REPORT_STATUS_IMMUTABLE`（`details` 带 current / next；`overwrite:true` 可显式覆盖；**自动收尾（`autoFinalized=true`）的终态可直接改正**） |
| 报告状态非法 / 报告用例跨节点 | 400 `VALIDATION_FAILED`，指出非法取值或归属节点 |
| 报告的 `runId` 指向不存在的 agent 任务 | 404 `NOT_FOUND` |
| 同节点内上线项重名 | 409 `RELEASE_ITEM_NAME_EXISTS`（upsert 走幂等覆盖，不报错） |
| 破坏性操作未确认 | 400 `CONFIRM_REQUIRED`，提示加 `--confirm` / `confirm: true` |
| AI/agent 触发高风险操作（上线检查 / 回归派单 / 状态流转 / 配置·SQL 变更）但未显式确认 | 403 `PERMISSION_DENIED`（`details` 带 action / actor / confirmRequired / auditId）；人工通道（user / cli / import）默认放行；拒绝同样写入 `audit_logs` |
| 移动到自身或后代（成环） | 400 |
| 必填属性缺失 / 类型不匹配 | 400，指出具体属性 label |
| sha 非法 | 400 |
| 同一节点重复登记同一 sha | 幂等，返回已存在记录 |
| 仓库未登记 / 本地路径不存在 | 400 `REPO_NOT_REGISTERED` / `REPO_PATH_MISSING`，提示先登记仓库 |
| 分支不存在（工作单元或集成分支） | 400 `BRANCH_NOT_FOUND` |
| 分支已存在但基线不同 | 400 `BRANCH_EXISTS_DIFFERENT_BASE`，提示确认或改用其他分支名 |
| worktree 路径已被占用 | 409 `WORKTREE_PATH_EXISTS` |
| 合并预检有冲突 | 返回 `precheck_conflict` + 冲突文件（**不改工作区、不落分支**），进入冲突处理 |
| 本机 git 不可用 / 命令失败 | 500 `GIT_UNAVAILABLE` / `GIT_FAILED`（`details` 带原始 stderr） |
| GitLab 未配置 | 400 + 「前往设置页配置」提示 |
| GitLab 401 / 404 | 502（`details` 区分 token 无效 / 项目路径错误） |
| GitLab 网络异常 / 超时（10s） | 502，既有 MR 数据不变 |
| 端口占用 | 自动 +1 重试至 3220，仍失败则报错退出 |
| 并发写入 | 单进程单写者；WAL 模式；接口层串行化写操作 |
| 上传文件类型 / 大小不合规 | 400，提示允许的格式（png / jpg / jpeg / gif / webp）与 10 MB 上限 |
| 数据备份 | 提示直接复制 `~/.taskboard/data.db` 与 `~/.taskboard/uploads/`（关闭进程后复制） |

错误码（AI 依赖，保持稳定）：`VALIDATION_FAILED`、`PARENT_TYPE_INVALID`、`LEAF_NODE`、`CYCLE_DETECTED`、`PATH_NOT_FOUND`、`PATH_AMBIGUOUS`、`DOC_NAME_EXISTS`、`TEST_CASE_NAME_EXISTS`、`RELEASE_ITEM_NAME_EXISTS`、`REPORT_STATUS_IMMUTABLE`、`CONFIRM_REQUIRED`、`PERMISSION_DENIED`、`UPLOAD_INVALID_TYPE`、`UPLOAD_TOO_LARGE`、`GITLAB_NOT_CONFIGURED`、`GITLAB_AUTH_FAILED`、`GITLAB_PROJECT_NOT_FOUND`、`GITLAB_UNAVAILABLE`、`REPO_NOT_REGISTERED`、`REPO_PATH_MISSING`、`BRANCH_NOT_FOUND`、`BRANCH_EXISTS_DIFFERENT_BASE`、`WORKTREE_PATH_EXISTS`、`MERGE_CONFLICT`、`GIT_UNAVAILABLE`、`GIT_FAILED`。

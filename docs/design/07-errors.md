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
| 移动到自身或后代（成环） | 400 |
| 必填属性缺失 / 类型不匹配 | 400，指出具体属性 label |
| sha 非法 | 400 |
| 同一节点重复登记同一 sha | 幂等，返回已存在记录 |
| 仓库未登记 / 本地路径不存在 | 400 `REPO_NOT_REGISTERED` / `REPO_PATH_MISSING`，提示先登记仓库 |
| 分支不存在（工作单元或集成分支） | 400 `BRANCH_NOT_FOUND` |
| 分支已存在但基线不同 | 400 `BRANCH_EXISTS_DIFFERENT_BASE`，提示确认或改用其他分支名。**判定用 tip 相等**：分支比基线更旧（祖先）或已领先都不算一致——前者会让开发者从过期代码开工，后者含未合并成果，都不静默复用 |
| worktree 路径已被占用 | 409 `WORKTREE_PATH_EXISTS`（被其他分支的 worktree 或同名普通目录占用；同分支同路径走幂等跳过） |
| 合并预检有冲突 | 返回 `precheck_conflict` + 冲突文件（**不改工作区、不落分支**），进入冲突处理。`merge-tree` exit=1 也按业务结果处理，不落成 500；冲突清单按 `-z` NUL 分隔解析，前缀型文件名与非 ASCII 路径都原样保留 |
| 合并未确认 | 400 `CONFIRM_REQUIRED`（HTTP/MCP `confirm:true`、CLI `--confirm`）|
| 合并记录确认 / 放弃 | `confirm` 只服务冲突行（可显式回填 `mergeSha`）、`abort` 置 `aborted`；已 `aborted`/`merged` 不可确认、已 `merged` 不可放弃 |
| 冲突 resolve 文件不完整 / 越出清单 | 400 `VALIDATION_FAILED`（缺文件或 path 不在 `conflict_files` 中，不静默忽略） |
| 冲突 resolve 写入未登记 worktree | 400 `VALIDATION_FAILED`（`writeToWorktree:true` 但没有 `unit_repos.worktree_path` 或目录不存在） |
| 本机 git 不可用 / 命令失败 | 500 `GIT_UNAVAILABLE` / `GIT_FAILED`（`details` 带原始 stderr） |
| GitLab 未配置 | 400 + 「前往设置页配置」提示 |
| GitLab 401 / 404 | 502（`details` 区分 token 无效 / 项目路径错误） |
| GitLab 网络异常 / 超时（10s） | 502，既有 MR 数据不变 |
| 端口占用 | 自动 +1 重试至 3220，仍失败则报错退出 |
| 并发写入 | 单进程单写者；WAL 模式；接口层串行化写操作 |
| 上传文件类型 / 大小不合规 | 400 `UPLOAD_INVALID_TYPE` / `UPLOAD_TOO_LARGE`，提示允许的格式（png / jpg / jpeg / gif / webp）与 10 MB 上限（`details` 带 `maxBytes` / `actualBytes` / `allowed`） |
| 上传请求体超过框架 JSON 限额（20 MB） | 413 `PAYLOAD_TOO_LARGE`（**不是** 500：框架层错误必须归一成业务码） |
| 请求体不是合法 JSON | 400 `VALIDATION_FAILED`（框架解析错误同样归一，不泄漏解析器英文消息） |
| 访问不存在的 `/uploads/*` | 404 `NOT_FOUND`——**终结性 404，不回落 SPA**；否则前端 `<img>` 会拿到 200 + index.html 而静默裂图 |
| 上传文件名含 `]` / `[` / `\` | 服务端返回转义后的 `alt`，Markdown 图片语法不被截断（否则落库正常、预览裂图） |
| CLI 上传本地文件不可读（不存在 / 是目录 / 无权限） | 400 `VALIDATION_FAILED`，`details.reason` 区分 `ENOENT` / `EISDIR` / `EACCES`（不裸抛 fs 错误） |
| 数据备份 | 提示直接复制 `~/.taskboard/data.db` 与 `~/.taskboard/uploads/`（关闭进程后复制） |

错误码（AI 依赖，保持稳定）：`VALIDATION_FAILED`、`PARENT_TYPE_INVALID`、`LEAF_NODE`、`CYCLE_DETECTED`、`NOT_FOUND`、`PATH_NOT_FOUND`、`PATH_AMBIGUOUS`、`DOC_NAME_EXISTS`、`TEST_CASE_NAME_EXISTS`、`RELEASE_ITEM_NAME_EXISTS`、`REPORT_STATUS_IMMUTABLE`、`CONFIRM_REQUIRED`、`UPLOAD_INVALID_TYPE`、`UPLOAD_TOO_LARGE`、`PAYLOAD_TOO_LARGE`、`GITLAB_NOT_CONFIGURED`、`GITLAB_AUTH_FAILED`、`GITLAB_PROJECT_NOT_FOUND`、`GITLAB_UNAVAILABLE`、`REPO_NOT_REGISTERED`、`REPO_PATH_MISSING`、`BRANCH_NOT_FOUND`、`BRANCH_EXISTS_DIFFERENT_BASE`、`WORKTREE_PATH_EXISTS`、`MERGE_CONFLICT`、`GIT_UNAVAILABLE`、`GIT_FAILED`。

**框架层错误归一**（`http.mjs` 的 `mapFrameworkError`）：body-parser / send 抛出的错误没有业务码，
直接透传会把「请求体过大」「JSON 格式错」这类纯客户端错误报成 500 服务端故障并刷错误日志堆栈。
现按 `err.type` 归一：`entity.too.large → 413 PAYLOAD_TOO_LARGE`、`entity.parse.failed → 400 VALIDATION_FAILED`、
`charset.unsupported → 415`、其余 `4xx` 静态层错误保留状态码并补稳定 code。

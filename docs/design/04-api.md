# 6. 接口（REST，JSON）

> 本文是主设计文档 [`../design.md`](../design.md) 的拆分章节；索引与章节导航见该文件。


| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回版本与数据文件路径 |
| GET | `/api/schema` | 节点类型、状态值域、属性定义、工具清单（AI 能力发现） |
| GET | `/api/revision` | 数据版本号（任何写入 +1），供前端轮询与 AI 判断变更 |
| GET | `/api/tree?format=md` | 缩进 markdown 树（AI 读取用）；默认 `json` |
| GET | `/api/tree` | 全量树数据：`[{id,type,parentId,name,status,sort,attrs:{key:value}}]`，前端组树与过滤 |
| GET | `/api/nodes/:id` | 节点详情：核心字段 + `attrs` + `commits` + `mrs` + `children` |
| POST | `/api/nodes` | 创建节点 `{parentId?, type, name, attrs?}`；校验父子类型 |
| PATCH | `/api/nodes/:id` | 更新 `{name?, status?, parentId?, attrs?}`；`attrs` 为 key→value 局部更新 |
| DELETE | `/api/nodes/:id` | 级联删除（返回删除的节点数与关联行数） |
| POST | `/api/nodes/reorder` | `{parentId, orderedIds[]}` 一次性写入同级顺序 |
| GET | `/api/requirements?projectId=&status=` | 需求管理列表：需求条目 + 文档关联状态 + 就绪结论 + KPI |
| POST | `/api/requirements` | 新建需求条目并自动关联「需求内容 / 概要设计」两份文档 `{projectId?, projectPath?, name, attrs?}` |
| POST | `/api/requirements/:id/transition` | 需求状态流转 `{status}`；只允许 `todo→doing→testing→done`，未完成前可取消，取消后可恢复 |
| POST | `/api/nodes/upsert` | 按路径 get-or-create（幂等）：`{path, type?, name?, attrs?}` |
| POST | `/api/batch` | 批量操作：`{ops:[...], dryRun?}`，一次调用执行多步 |
| POST | `/api/import` | 大纲导入：`{format:"md", content, parentPath?, dryRun?}` |
| GET | `/api/attr-defs?nodeType=` | 属性定义列表 |
| POST | `/api/attr-defs` | 新增属性定义 |
| PATCH | `/api/attr-defs/:id` | 编辑（label / data_type / options / required / sort / enabled） |
| DELETE | `/api/attr-defs/:id` | 删除定义（连带删除其属性值） |
| POST | `/api/nodes/:id/documents` | 新增文档 `{name, content?}` |
| POST | `/api/nodes/:id/documents/upsert` | 按文档名 get-or-create 并写内容（幂等）：`{name, content}` |
| PATCH | `/api/documents/:docId` | 更新文档 `{name?, content?}` |
| GET | `/api/documents/:docId/versions` | 文档历史版本（新→旧）：名称 / 正文 / 变更原因 / 操作者 / 时间 |
| POST | `/api/documents/:docId/versions/:versionId/restore` | 恢复文档到指定历史版本，追加新快照，不改写旧历史 |
| DELETE | `/api/documents/:docId` | 删除文档 |
| POST | `/api/nodes/:id/documents/reorder` | `{orderedIds[]}` 写入文档顺序 |
| POST | `/api/nodes/:id/commits` | `{repo?, sha, note?}` 登记 commit |
| DELETE | `/api/commits/:cid` | 删除登记 |
| GET | `/api/commits/:cid/diff` | 单 commit 预览：文件列表 + 每文件 old / new 与 patch |
| GET | `/api/nodes/:id/diffs?scope=self\|subtree` | 节点（含子树）聚合预览，按 commit / 仓库分组 |
| POST | `/api/nodes/:id/merges/precheck` | 合并预检（merge-tree，不落库、不合并） |
| POST | `/api/nodes/:id/merges` | 显式合并：`{repo?, confirm, dryRun?}`，逐仓库预检并合并，返回 `{merged[], conflicts[], failed[]}`；需 `confirm:true` |
| GET | `/api/merges?nodeId=&state=` | 合并记录列表（含待处理冲突） |
| GET | `/api/merges/:mid/conflicts` | 冲突详情：文件 + 冲突块 + base / ours / theirs 三方内容 |
| POST | `/api/merges/:mid/resolve` | 写回冲突处理结果 `{files:[{path, content}], writeToWorktree?}`；返回 `contentHash` 与可 `git apply` 的 unified `patches[]` |
| POST | `/api/merges/:mid/confirm` | 确认合并完成（本地已应用）→ 回填 `merge_sha`，置 `resolved` |
| POST | `/api/merges/:mid/abort` | 放弃本次合并 → `aborted`（不改任何分支） |
| GET | `/api/repos` | 仓库登记列表 |
| POST | `/api/repos` | 新增仓库 `{name, local_path?, gitlab_project?, note?}` |
| PATCH | `/api/repos/:rid` | 更新仓库 |
| DELETE | `/api/repos/:rid` | 删除仓库 |
| GET | `/api/nodes/:id/unit-repos` | 工作单元涉及的仓库（branch / worktree_path） |
| POST | `/api/nodes/:id/unit-repos` | 新增 `{repoId, branch?, worktreePath?}` |
| DELETE | `/api/unit-repos/:urid` | 移除工作单元仓库 |
| POST | `/api/nodes/:id/setup` | 创建工作区：`{repoIds?, dryRun?}` → 建分支 + worktree，返回 `{branch, repos:[{repo, worktreePath}], prompt}` |
| GET | `/api/nodes/:id/prompt` | 生成 / 刷新开发提示词 |
| POST | `/api/nodes/:id/cleanup` | 清理工作区（移除 worktree / 删除已合并分支；需 `confirm`） |
| GET | `/api/nodes/:id/mrs` | 该节点已拉取的 MR 列表 |
| POST | `/api/nodes/:id/mrs/refresh` | 拉取 MR：`{pulled, created, updated, errors[]}` |
| GET | `/api/config` | 读取配置（token 打码） |
| PUT | `/api/config` | 保存配置 |
| POST | `/api/config/gitlab/test` | GitLab 连通性测试（返回当前用户与项目可达性） |
| POST | `/api/uploads` | 上传图片：请求体 JSON `{ name, data }`（`data` 为 base64 或 data URL，`express.json` 限额 20 MB），存入 `~/.taskboard/uploads/`，返回 `{ url, name, size, mime }`；扩展名白名单 + ≤10 MB + 魔数交叉校验 |
| GET | `/uploads/:name` | 图片静态访问（Markdown 预览使用） |

### 回归测试闭环（AI 可回归测试 → 测试/验收报告）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/nodes/:id/test-cases` | 该节点的测试用例；`?kind=` 筛类型，`?includeDisabled=true` 含停用 |
| POST | `/api/nodes/:id/test-cases` | 新增用例 `{name, prompt, kind?, expectation?, enabled?}`；重名 → 409 `TEST_CASE_NAME_EXISTS` |
| POST | `/api/nodes/:id/test-cases/upsert` | 按用例名 get-or-create 并写内容（幂等）：`{name, prompt, kind?, expectation?}` |
| POST | `/api/nodes/:id/test-cases/reorder` | `{orderedIds[]}` 重排用例 |
| PATCH | `/api/test-cases/:cid` | 更新用例 `{name?, kind?, prompt?, expectation?, enabled?}` |
| DELETE | `/api/test-cases/:cid` | 删除用例（历史报告保留，`case_id` 置空） |
| POST | `/api/nodes/:id/test-runs` | 派单执行：`{caseIds?, kind?, prompt?, agent?, model?, cwd?, dryRun?}`；为每条用例开 `running` 报告，返回 `{node, kind, run, reports}`（dryRun 只回用例与提示词）；任务落终态时自动收尾关联报告（见下） |
| GET | `/api/nodes/:id/test-reports` | 报告列表（倒序）；`?caseId=&kind=&limit=` |
| GET | `/api/test-reports/:rid` | 单条报告详情 |
| PATCH | `/api/test-reports/:rid` | 回写报告 `{status, summary?, detail?, runId?, overwrite?}`；`running → 终态` 单向，终态同状态幂等；终态互转默认拒绝 `REPORT_STATUS_IMMUTABLE`（409），`overwrite:true` 才覆盖；**自动收尾（`autoFinalized=true`）的终态可无需 `overwrite` 直接改正**；非法 `status` → 400 `VALIDATION_FAILED` |
| GET | `/api/nodes/:id/acceptance-report` | 验收报告聚合：`?scope=self\|subtree`，`?format=json\|md`（md 直接贴 issue/MR）。分桶总数守恒（`pass+fail+blocked+error+cancelled+running+notRun=cases`）；`running`/`notRun` 不计入通过率分母 |
| GET | `/api/nodes/:id/acceptance-status` | 验收签收状态：`?scope=self\|subtree`，`?format=json\|md`。返回测试证据、签收结论与 `pending/accepted/rejected/stale`；证据变化让签收自动失效 |
| POST | `/api/nodes/:id/acceptance-signoff` | 签收 / 驳回验收：`{decision: accepted\|rejected, scope?, comment?}`；绑定当前证据指纹 |

### 需求就绪门禁（需求管理闭环的前置判定）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/nodes/:id/readiness` | 需求就绪门禁：`?scope=self\|subtree`，`?format=json\|md`。判定需求内容 / 概要设计 / 可回归用例三条门禁；只判 `requirement` / `subreq`（其它类型 `self` → 400 `VALIDATION_FAILED`，提示用 `scope=subtree`）；无待判定需求时 `ready=null`；**纯读聚合，不写库、不动 revision** |

### 概要设计大纲 / 思维导图（需求管理 → 概要设计 → 文档）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/nodes/:id/design-outline` | 概要设计大纲：`?scope=self\|subtree`，`?format=json\|md`。从需求树的子需求 / 任务组 / 子任务结构推导骨架；`md` 含 mermaid mindmap + 逐层小节（按节点类型给出「目标与范围 / 子需求设计 / 任务组拆分 / 实现要点 / 缺陷处理」），可直接写入「概要设计」文档；只判 `requirement` / `subreq`（其它类型 `self` → 400 `VALIDATION_FAILED`，提示用 `scope=subtree`）；**纯读聚合，不写库、不动 revision** |
| POST | `/api/nodes/:id/design-outline/apply` | 把推导出的骨架写入各需求的「概要设计」文档（文档名取 `config.readiness.designDoc`，与需求就绪门禁同一份）：`{scope?, overwrite?, dryRun?}`。默认 `overwrite:false`——已有非空文档原样保留并回报 `written:false / reason=already_filled`；`overwrite:true` 才覆盖。`dryRun:true` 只回报将写哪些、**不落库不动 revision**（与 `overwrite:true` 组合时也只预演，不覆盖）。返回逐单元 `results[]` 与 `written` / `skipped` 计数 |
### 思维导图（树 → mermaid mindmap 的只读投影）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/nodes/:id/mindmap` | 思维导图：`?scope=self\|subtree`（缺省 `self`；Web 页签默认 `subtree`）、`?maxDepth=0..50`（缺省不截断）、`?format=json\|md`。返回 mermaid `mindmap` 文本 + 结构化 `nodes`/`edges`/`totals`；`totals.truncated` 记超过 `maxDepth` 被截断的子节点数；标签转义 `"`/`&`，空名用占位符；**纯读投影，不写库、不动 revision** |

### 交付门禁（需求就绪 / 测试验收 / 上线治理的最终汇总）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/nodes/:id/delivery-gate` | 交付门禁：`?scope=self\|subtree`，`?format=json\|md`。汇总 `readiness` / `acceptance` / `release` 三个来源，每个来源为 `pass` / `fail` / `not_applicable`；验收来源要求测试全过且验收签收有效（`accepted`），`pending/rejected/stale` 都会阻塞；最终 `decision` 为 `ready` / `not_ready` / `unknown`；**纯读聚合，不写库、不动 revision** |

聚合类接口的 `scope` / `format` 均为枚举参数：`scope=self|subtree`（缺省 `self`）、`format=json|md`（缺省 `json`）；
其它取值一律 `400 VALIDATION_FAILED`，三入口不做静默降级。交付门禁的验收来源只聚合**启用中**的测试用例：
停用用例既不算 `notRun`，也不阻塞交付（与需求就绪门禁口径一致）。

### 上线治理（上线配置 / 上线 SQL / 上线检查清单）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/nodes/:id/release-items` | 该节点的上线项；`?kind=config\|sql\|check`、`?status=` 筛，`?includeOptional=false` 只看必做 |
| POST | `/api/nodes/:id/release-items` | 新增上线项 `{name, kind?, content?, rollback?, status?, required?}`；重名 → 409 `RELEASE_ITEM_NAME_EXISTS` |
| POST | `/api/nodes/:id/release-items/upsert` | 按项名 get-or-create 并写内容（幂等）：`{name, kind?, content?, rollback?, status?, required?}`。**新建**时未传字段取默认值；**已存在**时只更新显式传入的字段（未传的保持原样）；入口一律透传、不补默认值 |
| POST | `/api/nodes/:id/release-items/reorder` | `{orderedIds[]}` 重排上线项 |
| PATCH | `/api/release-items/:rid` | 更新上线项 `{name?, kind?, content?, rollback?, status?, required?}` |
| DELETE | `/api/release-items/:rid` | 删除上线项 |
| GET | `/api/nodes/:id/release-checklist` | 上线检查清单：`?scope=self\|subtree`，`?format=json\|md`（md 直接贴上线单）|
| POST | `/api/nodes/:id/release-checks` | 派单上线前置检查：`{caseIds?, scope?, prompt?, agent?, model?, cwd?, dryRun?}`；按 scope（`self`/`subtree`）挑 `code_check`/`biz_check`/`release_check` 用例，为每条开 `running` 报告（dryRun 只回清单与提示词） |

### agent 运行时 / 会话 / 任务

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/runtimes` | 运行时列表 + 总览统计 `{summary, items}`；`?status=online\|offline` |
| POST | `/api/runtimes` | 注册/更新运行时 `{name, daemonId, provider?, runtimeMode?, deviceInfo?, visibility?}`（按 daemonId+provider 幂等） |
| GET | `/api/runtimes/:id` | 运行时详情 |
| POST | `/api/runtimes/:id/heartbeat` | 心跳：刷新 `last_seen_at` 并置 online |
| PATCH | `/api/runtimes/:id` | `{status: online\|offline}` 手动改状态 |
| DELETE | `/api/runtimes/:id` | 删除运行时（有未完成任务时 `400`；历史任务解绑保留） |
| GET | `/api/nodes/:id/agent-sessions` | 节点上的会话列表（`?status=active\|archived`） |
| POST | `/api/nodes/:id/agent-sessions` | 新建会话 `{agent?, workDir?, title?}`（不复用旧会话） |
| GET | `/api/agent-sessions/:sid` | 会话详情 |
| PATCH | `/api/agent-sessions/:sid` | 更新 `{title?, status?, cliSessionId?, workDir?}` |
| DELETE | `/api/agent-sessions/:sid` | 归档会话（置 `archived`） |
| POST | `/api/nodes/:id/agent-runs` | 派单：`{prompt, agent?, model?, cwd?, ideMode?, sessionId?, resume?, runtimeId?}`；异步执行，返回任务 |
| GET | `/api/nodes/:id/agent-runs` | 任务历史 `?limit=&sessionId=`（倒序） |
| GET | `/api/agent-runs/:rid` | 任务详情 |
| GET | `/api/agent-runs/:rid/messages` | 任务消息流 `?sinceSeq=`（按 seq 增量拉取） |
| POST | `/api/agent-runs/:rid/messages` | 追加一条消息 `{type, tool?, content?, input?, output?}` |
| POST | `/api/agent-runs/:rid/cancel` | 取消未完成任务并终止本地子进程 `{reason?}` |
| POST | `/api/agent-runs/:rid/retry` | 重试已结束任务（新建 attempt+1 子任务，回指原任务）；`attempt >= maxAttempts` 时 `400` 拒绝 |
| PATCH | `/api/agent-runs/:rid` | 回写终态 `{status, output?, exitCode?, failureReason?, cliSessionId?, workDir?}` |

状态码：参数/父子类型/必填校验失败 → `400`；资源不存在 → `404`；唯一约束冲突 / 路径歧义 → `409`；GitLab 侧错误 → `502`（`details` 带原始信息）。破坏性操作未显式确认 → `400`，`code = CONFIRM_REQUIRED`。合并预检发现冲突不改工作区，返回 `200` + 冲突清单（`state = precheck_conflict`）；本机 git 不可用 / 失败 → `500`（`GIT_UNAVAILABLE` / `GIT_FAILED`）。

**`scope` 参数值域（所有聚合类接口统一）**：只接受 `self` / `subtree`，缺省（不传）等价于 `self`；
其余取值（含大小写错如 `Subtree`、拼错、多值、空串）一律 `400 VALIDATION_FAILED`，
`details.allowed = ["self","subtree"]`。**不做静默降级**——早期实现把非 `subtree` 的值吞成 `self`，
会在「本节点就绪、子树未就绪」时把放行门禁的结论从「未就绪」翻成「就绪」。
适用接口：`/readiness`、`/mindmap`、`/acceptance-report`、`/release-checklist`、`/delivery-gate`、
`/diffs`、`/tracks`、`/duplicates`，以及 `release-checks` 请求体的 `scope`。

**`format` 参数值域（带 md 渲染的读接口）**：只接受 `json` / `md`，缺省（不传）等价于 `json`；
其余取值（如 `xml`、空串）一律 `400 VALIDATION_FAILED`，`details.allowed = ["json","md"]`。
MCP 工具同样返回 `isError` + `VALIDATION_FAILED` 文本，不泄漏 SDK 的 `-32602` 协议错误。
这条口径横切所有吃 `scope` 的 MCP 工具：`requirement_readiness` / `mindmap` / `acceptance_report` / `delivery_gate` /
`release_checklist` / `node_diffs` / `node_tracks` / `commit_duplicates` / `release_check`。
概要设计大纲（`design_outline` / `design_outline_apply`）同样吃这套 `scope` / `format` 校验。

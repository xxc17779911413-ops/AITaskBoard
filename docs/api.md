# 接口速查（REST）

> - **权威定义**见 [`design.md` §6](./design.md)；运行时能力以 `GET /api/schema` 为准。
> - 所有错误统一为 `{ "error": { "code", "message", "details"? } }`，`code` 稳定、机器可解析。
> - Base URL：`http://127.0.0.1:3210`
> - MCP 工具与 CLI 命令是这些接口的 1:1 映射（见 [`../AGENTS.md`](../AGENTS.md)）。

## 发现与读取

### 健康检查

```bash
curl -s http://127.0.0.1:3210/api/health
```

```json
{ "ok": true, "revision": 10 }
```

### 能力发现（**AI 首选** —— 用它代替猜字段）

```bash
curl -s http://127.0.0.1:3210/api/schema
```

```json
{
  "version": 1,
  "nodeTypes": [
    { "type": "project",     "allowedChildren": ["requirement"] },
    { "type": "requirement", "allowedChildren": ["subreq"] },
    { "type": "subreq",      "allowedChildren": ["group", "task"] },
    { "type": "group",       "allowedChildren": ["group", "task", "defect"] },
    { "type": "task",        "allowedChildren": ["defect"] },
    { "type": "defect",      "allowedChildren": [] }
  ],
  "status": {
    "labels":  { "todo": "待开始", "doing": "进行中", "testing": "提测中", "done": "已完成", "cancelled": "已取消" },
    "allowed": { "project": ["todo","doing","done"], "requirement": ["todo","doing","testing","done","cancelled"], "subreq": ["todo","doing","done"], "group": ["todo","doing","done"], "task": ["todo","doing","done"], "defect": ["todo","doing","done","cancelled"] }
  },
  "docPresets": { "project": ["描述"], "requirement": ["需求内容"], "subreq": ["需求内容"], "group": [], "task": [], "defect": ["描述","复现步骤"] },
  "branchTemplate": "{base_branch}-{slug}",
  "attrDefs": [ { "nodeType": "requirement", "key": "start_date", "label": "开始时间", "dataType": "date", "required": false } ],
  "tools": ["schema", "tree", "node_get", "node_upsert", "..."]
}
```

### 数据版本号（前端每 10s 轮询）

```bash
curl -s http://127.0.0.1:3210/api/revision
```

```json
{ "revision": 10 }
```

> 任何写入使 revision +1；**一次用户/AI 操作只递增一次**（组合写入不重复计数）。

### 读整棵树

```bash
# JSON（每个节点带 docCount / childCount，供表格列直接绑定）
curl -s http://127.0.0.1:3210/api/tree

# Markdown 大纲（缩进树，可直接喂给 /api/import）
curl -s 'http://127.0.0.1:3210/api/tree?format=md'
```

```json
{
  "revision": 10,
  "nodes": [
    { "id": 1, "type": "project", "parentId": null, "name": "充电平台", "status": "doing",
      "sort": 10, "path": "充电平台", "docCount": 1, "childCount": 6, "children": [ /* … */ ] }
  ]
}
```

### 节点详情

```bash
curl -s http://127.0.0.1:3210/api/nodes/1      # 也支持路径：/api/nodes/充电平台%2F需求A
```

```json
{
  "id": 1, "type": "project", "parentId": null, "name": "充电平台", "status": "doing",
  "path": "充电平台", "createdBy": "user", "updatedBy": "user",
  "attrs": { "req_no": "26Q3" },
  "documents": [ { "id": 4, "name": "需求内容", "content": "…", "sort": 10 } ],
  "commits": [ { "id": 1, "repo": "xp-charge", "sha": "abc1234", "note": "修复导出" } ],
  "children": [ { "id": 2, "type": "requirement", "name": "26Q3", "childCount": 23 } ]
}
```

## 节点写操作

### 创建节点

```bash
curl -s -X POST http://127.0.0.1:3210/api/nodes \
  -H 'content-type: application/json' \
  -d '{"type":"project","name":"充电平台"}'
```

```json
{ "id": 1, "type": "project", "parentId": null, "name": "充电平台", "status": "todo", "sort": 10, "path": "充电平台" }
```

非法父子组合 → `400`：

```json
{ "error": { "code": "PARENT_TYPE_INVALID", "message": "project 下不能挂 project",
             "details": { "type": "project", "parentType": "project", "allowedChildren": ["requirement"] } } }
```

### 更新节点（属性用局部 key→value）

```bash
curl -s -X PATCH http://127.0.0.1:3210/api/nodes/1 \
  -H 'content-type: application/json' \
  -d '{"name":"充电平台（改名）","status":"doing","attrs":{"req_no":"26Q3"}}'
```

### 移动 / 删除（**破坏性，必须 confirm**）

```bash
curl -s -X PATCH http://127.0.0.1:3210/api/nodes/5 \
  -H 'content-type: application/json' -d '{"parentPath":"充电平台/26Q3","confirm":true}'

curl -s -X DELETE 'http://127.0.0.1:3210/api/nodes/5?confirm=true'
```

未确认 → `400`：

```json
{ "error": { "code": "CONFIRM_REQUIRED", "message": "删除节点 充电平台/26Q3 需要 confirm" } }
```

### 同级排序

```bash
curl -s -X POST http://127.0.0.1:3210/api/nodes/reorder \
  -H 'content-type: application/json' -d '{"parentPath":"充电平台","orderedIds":[3,2,1]}'
```

## 需求管理（需求条目 / 状态流转 / 文档关联）

```bash
# 需求列表 + KPI（可按项目和状态筛选）
curl -s 'http://127.0.0.1:3210/api/requirements?projectId=1'
curl -s 'http://127.0.0.1:3210/api/requirements?projectId=1&status=doing'

# 新建需求：自动关联「需求内容」与「概要设计」两份文档
curl -s -X POST http://127.0.0.1:3210/api/requirements \
  -H 'content-type: application/json' \
  -d '{"projectId":1,"name":"26Q3 充电订单导出"}'

# 状态流转：todo→doing→testing→done；未完成前可 cancelled；cancelled 可恢复 todo
curl -s -X POST http://127.0.0.1:3210/api/requirements/2/transition \
  -H 'content-type: application/json' -d '{"status":"doing"}'

# CLI / MCP 等价入口
# node bin/taskboard.js requirement list --project "项目A" [--status doing]
# node bin/taskboard.js requirement create --project "项目A" --name "需求1"
# node bin/taskboard.js requirement transition "项目A/需求1" --status doing
# MCP: requirement_list / requirement_create / requirement_transition
```

```json
{
  "revision": 12,
  "summary": {
    "total": 3,
    "byStatus": { "todo": 1, "doing": 1, "testing": 1, "done": 0, "cancelled": 0 },
    "missingRequirementDoc": 1,
    "missingDesignDoc": 2
  },
  "items": [
    {
      "id": 2,
      "type": "requirement",
      "name": "26Q3 充电订单导出",
      "status": "doing",
      "docState": [
        { "name": "需求内容", "linked": true, "filled": true },
        { "name": "概要设计", "linked": true, "filled": false }
      ],
      "canTransitionTo": ["testing", "cancelled"]
    }
  ]
}
```

> 创建需求会把「需求内容」和「概要设计」两份文档槽位一次性建好；`filled=false` 只表示文档已关联但正文仍为空。
> 非法状态跳转返回 `400 VALIDATION_FAILED`，通用 `PATCH /api/nodes/:id` 也不能绕过需求状态机。

## 文档管理（需求文档集中检索 / 缺口对账）

```bash
# 集中列出需求文档；可按项目 / 需求状态 / 关键词 / 文档名 / 填充状态筛选
curl -s 'http://127.0.0.1:3210/api/documents/overview?projectId=1'
curl -s 'http://127.0.0.1:3210/api/documents/overview?projectId=1&q=导出'
curl -s 'http://127.0.0.1:3210/api/documents/overview?projectId=1&docName=概要设计&fill=empty'

# CLI / MCP 等价入口
# node bin/taskboard.js document overview --project "项目A" [--q 导出] [--doc-name 概要设计] [--fill empty]
# MCP: document_overview { project, status?, q?, docName?, fill? }
```

```json
{
  "scope": { "projectId": 1, "status": null },
  "expectedDocNames": ["需求内容", "概要设计"],
  "summary": {
    "requirementCount": 2,
    "documentCount": 3,
    "requiredSlotCount": 4,
    "filledRequiredSlotCount": 1,
    "emptyRequiredSlotCount": 2,
    "unlinkedRequiredSlotCount": 1,
    "missingRequiredSlotCount": 3,
    "gapRequirementCount": 2,
    "filteredDocumentCount": 3,
    "filteredGapCount": 3
  },
  "items": [
    { "id": 4, "name": "需求内容", "nodeName": "需求1", "filled": true, "isRequired": true, "path": "项目A/需求1" }
  ],
  "gaps": [
    { "nodeName": "需求1", "docName": "概要设计", "linked": true, "gapType": "empty" }
  ]
}
```

> `fill` 只接受 `filled` / `empty`，非法值返回 `400 VALIDATION_FAILED`。
> 聚合不写库、不动 revision；点击文档后仍复用原有文档编辑链路。

## 幂等写入（AI 首选）

### 按路径 get-or-create

```bash
curl -s -X POST http://127.0.0.1:3210/api/nodes/upsert \
  -H 'content-type: application/json' \
  -d '{"path":"充电平台/26Q3/3.1 收发货","attrs":{"branch":"feature-send-receive"}}'
```

```json
{
  "node": { "id": 2, "type": "requirement", "name": "3.1 收发货", "path": "充电平台/26Q3/3.1 收发货" },
  "steps": [ { "path": "充电平台/26Q3", "type": "requirement", "action": "create" } ]
}
```

> 重复调用安全：已存在的层级不重建，`steps` 为空数组。

### 批量（多步一次调用，单步失败不影响其余）

```bash
curl -s -X POST http://127.0.0.1:3210/api/batch \
  -H 'content-type: application/json' \
  -d '{"ops":[
        {"op":"node.upsert","path":"充电平台/26Q3"},
        {"op":"doc.upsert","ref":"充电平台/26Q3","name":"需求内容","content":"# 目标\n…"},
        {"op":"attr.set","ref":"充电平台/26Q3","attrs":{"req_no":"26Q3"}}
      ],"dryRun":false}'
```

```json
{ "dryRun": false, "total": 3, "failed": 0,
  "results": [ { "index": 0, "op": "node.upsert", "ok": true, "result": { "id": 2 } } ] }
```

### 大纲导入（markdown 缩进树）

```bash
curl -s -X POST http://127.0.0.1:3210/api/import \
  -H 'content-type: application/json' \
  -d '{"content":"- 项目A\n  - 需求1\n    - 子需求1\n      - [task] 子任务1","dryRun":true}'
```

```json
{ "dryRun": true, "count": 4, "steps": [ { "path": "项目A", "type": "project", "action": "create" } ] }
```

> 规则：缩进 2 空格；`[task]` / `[defect]` 显式标注，其余按层级推导；`键: 值` 行为属性；`#` 开头行忽略。

## 文档

```bash
# 列出
curl -s http://127.0.0.1:3210/api/nodes/1/documents

# 按文档名 upsert（幂等）
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/documents/upsert \
  -H 'content-type: application/json' \
  -d '{"name":"需求内容","content":"# 目标\n\n支持子公司开票"}'

# 改内容 / 改名
curl -s -X PATCH http://127.0.0.1:3210/api/documents/4 \
  -H 'content-type: application/json' -d '{"content":"新正文"}'

# 排序 / 删除
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/documents/reorder \
  -H 'content-type: application/json' -d '{"orderedIds":[5,4]}'
curl -s -X DELETE http://127.0.0.1:3210/api/documents/4
```

### 文档历史与恢复

```bash
curl -s http://127.0.0.1:3210/api/documents/4/versions
curl -s -X POST http://127.0.0.1:3210/api/documents/4/versions/2/restore
```

```json
{
  "document": { "id": 4, "name": "需求内容", "content": "旧正文", "updatedBy": "user" },
  "version": { "id": 5, "documentId": 4, "name": "需求内容", "content": "旧正文", "reason": "restore", "createdBy": "user" }
}
```

重名 → `409`：

```json
{ "error": { "code": "DOC_NAME_EXISTS", "message": "节点下已存在文档「需求内容」" } }
```

### 文档图片上传

Vditor 粘贴 / 拖拽 / 选择图片后走这里；落盘到 `~/.taskboard/uploads/`，返回的地址可直接写进 Markdown。

```bash
# base64（也接受 data:image/png;base64,... 形式）
curl -s -X POST http://127.0.0.1:3210/api/uploads \
  -H 'content-type: application/json' \
  -d "{\"name\":\"shot.png\",\"data\":\"$(base64 -i shot.png)\"}"
```

```json
{ "url": "/uploads/1757900000000-a1b2c3d4e5f6.png", "name": "1757900000000-a1b2c3d4e5f6.png", "size": 20481, "mime": "image/png", "alt": "shot.png" }
```

```bash
# 静态访问（Markdown 预览即走这里）
curl -s -o out.png http://127.0.0.1:3210/uploads/1757900000000-a1b2c3d4e5f6.png

# 不存在的图片 → 404（终结性，不会回落 SPA 变成 200 HTML）
curl -s -o - -w '\n%{http_code}\n' http://127.0.0.1:3210/uploads/nope.png

# CLI / MCP 等价入口
# node bin/taskboard.js upload ./shot.png [--name x.png] [--data <base64>]
# MCP: upload_image { name, data }
```

校验口径：扩展名白名单（`png / jpg / jpeg / gif / webp`）→ 解码后字节数 ≤ 10 MB → **魔数**与声明类型交叉校验
（改名 / 伪装的类型不符一律拦下，落盘扩展名以真实内容为准）。
返回体里的 `alt` 是服务端转义好的文件名（`]` `[` `\` 已转义），前端直接拼进 `![alt](url)` 即可，
避免文件名含 `]` 时截断 Markdown 图片语法。

不合规返回：

```json
{ "error": { "code": "UPLOAD_INVALID_TYPE", "message": "文件扩展名（.png）与内容不符，实际为 .gif", "details": { "allowed": ["png","jpg","jpeg","gif","webp"], "maxBytes": 10485760 } } }
```

请求体超过 20 MB JSON 限额 → `413 PAYLOAD_TOO_LARGE`；请求体不是合法 JSON → `400 VALIDATION_FAILED`。
两者都**不会**再落到 500 `INTERNAL_ERROR`（框架层错误已按下表归一）：

| HTTP | code | 场景 |
|---|---|---|
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 `express.json` 的 20 MB 限额（图片单张上限 10 MB） |
| 400 | `VALIDATION_FAILED` | 请求体不是合法 JSON |

## 提交登记 / 仓库 / 配置

```bash
# 登记 commit（同节点同 sha 幂等；repo 需先登记）
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/commits \
  -H 'content-type: application/json' -d '{"repo":"xp-charge","sha":"abc1234","note":"修复导出"}'

# 子树聚合读取
curl -s 'http://127.0.0.1:3210/api/nodes/1/commits?subtree=true'

# 仓库登记
curl -s -X POST http://127.0.0.1:3210/api/repos \
  -H 'content-type: application/json' -d '{"name":"xp-charge","localPath":"/Users/me/charge2/xp-charge"}'

# 配置读写（token 打码）
curl -s http://127.0.0.1:3210/api/config
curl -s -X PUT http://127.0.0.1:3210/api/config \
  -H 'content-type: application/json' -d '{"port":3210,"gitlab":{"base_url":"https://gitlab.example.com","token":"xxx"}}'

# GitLab 连通性
curl -s -X POST http://127.0.0.1:3210/api/config/gitlab/test
```

## 工作区准备（分支 / worktree / 开发提示词）

工作单元（`group` / `task`）登记涉及仓库后，一次调用在**每个仓库**建出同名分支 + 各自 worktree；
分支从**所属子需求分支的当前最新提交**派生（不是登记时刻的快照）。

```bash
# 登记工作单元涉及仓库（按 node × repo 幂等）
curl -s -X POST http://127.0.0.1:3210/api/nodes/9/unit-repos \
  -H 'content-type: application/json' -d '{"repoId":1}'
curl -s http://127.0.0.1:3210/api/nodes/9/unit-repos

# 先预演（不碰 git、不落库）
curl -s -X POST http://127.0.0.1:3210/api/nodes/9/setup \
  -H 'content-type: application/json' -d '{"dryRun":true}'

# 真正创建：返回 { branch, baseBranch, repos:[{repo, worktreePath}], prompt }
curl -s -X POST http://127.0.0.1:3210/api/nodes/9/setup \
  -H 'content-type: application/json' -d '{}'

# 生成 / 刷新开发提示词（纯读，可直接投喂 AI）
curl -s http://127.0.0.1:3210/api/nodes/9/prompt

# 清理（需 confirm；未并入基线的分支会保留）
curl -s -X POST http://127.0.0.1:3210/api/nodes/9/cleanup \
  -H 'content-type: application/json' -d '{"confirm":true}'

# CLI / MCP 等价入口
# node bin/taskboard.js unit setup "项目A/需求1/任务1" [--dry-run]
# node bin/taskboard.js unit prompt "项目A/需求1/任务1"
# node bin/taskboard.js unit cleanup "项目A/需求1/任务1" --confirm [--keep-branch]
# MCP: unit_setup / unit_prompt / unit_cleanup
```

分支名由 `config.branchTemplate` 渲染（默认 `{base_branch}-{slug}`，`slug` 为空退回 `n{id}`）；
worktree 路径为 `config.worktreeRoot`（缺省与主仓库同级）下 `<仓库目录名>-wt-<slug>`。

清理的删除判定**相对声明的基线分支**（`git merge-base --is-ancestor <branch> <base>`），
不是相对当前 HEAD——`git branch -d` 会把「已并入 HEAD 但未并入基线」的分支也删掉。
未并入基线的分支一律保留并回报 `branchNote: 'branch-not-merged'`；
HTTP / MCP 传 `removeBranch: false`、CLI 传 `--keep-branch` 可显式保留分支（回报 `kept_by_request`）。

失败语义（都可按码自纠）：

| HTTP | code | 场景 |
|---|---|---|
| 409 | `WORKTREE_PATH_EXISTS` | 目标路径已被**其他分支**的 worktree 或同名普通目录占用 |
| 400 | `BRANCH_EXISTS_DIFFERENT_BASE` | 同名分支已存在但 tip 不等于基线（含「更旧」与「已领先」两种）。**在任何 git 写操作之前判定**，拒绝时零副作用，重试仍拒绝 |
| 400 | `BRANCH_NOT_FOUND` | 基线分支不存在（先确认子需求分支已建） |
| 400 | `CONFIRM_REQUIRED` | `cleanup` 未带 `confirm: true` |
| 400 | `VALIDATION_FAILED` | 非 `group` / `task` 节点、未登记涉及仓库、`repoId` 不在列表里 |

## agent 运行时 / 会话 / 任务

三层模型：**运行时（机器级执行环境）→ 会话（可续跑的连续对话）→ 任务（一次执行）**，
任务之上挂一层按 `seq` 递增的消息流。服务启动时会把本机 qodercli 运行时注册为在线。

```bash
# 运行时列表 + 总览（online / activeRuns / activeSessions）
curl -s http://127.0.0.1:3210/api/runtimes

# 注册/更新运行时（按 daemonId + provider 幂等 upsert）
curl -s -X POST http://127.0.0.1:3210/api/runtimes \
  -H 'content-type: application/json' \
  -d '{"name":"MacBook-Pro · qodercli","daemonId":"MacBook-Pro.local","provider":"qodercli"}'

# 心跳（刷新 last_seen_at + 置 online）
curl -s -X POST http://127.0.0.1:3210/api/runtimes/1/heartbeat

# 节点上的会话（可续跑的连续对话）
curl -s 'http://127.0.0.1:3210/api/nodes/1/agent-sessions'
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/agent-sessions \
  -H 'content-type: application/json' -d '{"agent":"qodercli","title":"第一次评审"}'

# 派单（服务端异步执行，立即返回 run；缺省自动挂该节点活动会话并注册本机运行时）
# 注：CLI 的 `agent run` 默认在前台进程内有界等到终态（--no-wait 退回只派单），
#     因为 CLI 进程退出后子进程收尾监听器不再触发，任务会永远停在 running。
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/agent-runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"跑一遍单测","agent":"qodercli","resume":true}'

# 任务详情 / 消息流（sinceSeq 增量拉取）/ 取消 / 重试
curl -s http://127.0.0.1:3210/api/agent-runs/7
curl -s 'http://127.0.0.1:3210/api/agent-runs/7/messages?sinceSeq=4'
curl -s -X POST http://127.0.0.1:3210/api/agent-runs/7/cancel \
  -H 'content-type: application/json' -d '{"reason":"user_cancelled"}'
curl -s -X POST http://127.0.0.1:3210/api/agent-runs/7/retry
```

## 回归测试闭环（AI 可回归测试 → 测试/验收报告）

```bash
# 写用例（按名幂等；kind 缺省 regression，可为 acceptance/code_check/biz_check/release_check）
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/test-cases/upsert \
  -H 'content-type: application/json' \
  -d '{"name":"登录回归","prompt":"在本仓库跑 npm test 并确认登录相关用例全绿","expectation":"全绿","kind":"regression"}'

# 列用例（可筛 kind / 含停用）
curl -s 'http://127.0.0.1:3210/api/nodes/1/test-cases?kind=regression'

# 预演派单：只回将要执行的用例与拼好的提示词，不落库不派单
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/test-runs \
  -H 'content-type: application/json' -d '{"dryRun":true}'

# 正式派单：为每条用例开一条 running 报告，返回 {run, reports}
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/test-runs \
  -H 'content-type: application/json' -d '{"kind":"regression"}'

# 并行派单（fan-out）：每条用例派一个独立 agent 任务，返回 {runs, reports, tasks}；
# maxParallel 必须是 number 类型的 1..16 整数（缺省 4）；非 number / 越界 / 选中数超护栏
# 一律 400 VALIDATION_FAILED（不静默降级、不静默截断）；fanout:false 时同样校验
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/test-runs \
  -H 'content-type: application/json' -d '{"kind":"regression","fanout":true,"maxParallel":4}'

# 重试失败的执行：会为用例随 child run 新开 running 报告，child 终态刷新后验收报告随之更新
curl -s -X POST http://127.0.0.1:3210/api/agent-runs/7/retry
```

> **两种派单模式**：缺省 `grouped` 把选中用例拼成一段提示词、派一个 agent 任务、共用一条 run（向后兼容）；
> `fanout:true` 每条用例一个独立任务（真并行、独立提示词、独立输出），报告与任务一一对应，
> 可单独 `cancel` / `retry`；`dryRun` 在两种模式下都只回报将派的任务与提示词，不落库不动 revision。

```bash
# 任务跑完后回写报告终态（前台执行者 / 收尾钩子调用）
# running → 终态单向；终态重复提交同状态幂等；终态互转默认 409，需显式 overwrite:true
curl -s -X PATCH http://127.0.0.1:3210/api/test-reports/3 \
  -H 'content-type: application/json' \
  -d '{"status":"pass","summary":"17/17 全绿","detail":"npm test 输出见 run 7"}'

# 幂等重放（同状态）不报错；若要纠正误判（终态互转）显式覆盖
curl -s -X PATCH http://127.0.0.1:3210/api/test-reports/3 \
  -H 'content-type: application/json' -d '{"status":"pass","summary":"复跑仍全绿"}'
curl -s -X PATCH http://127.0.0.1:3210/api/test-reports/3 \
  -H 'content-type: application/json' -d '{"status":"fail","overwrite":true,"summary":"验收纠正"}'

# 报告列表 / 单条 / 单条报告导出
curl -s 'http://127.0.0.1:3210/api/nodes/1/test-reports?limit=20'
curl -s http://127.0.0.1:3210/api/test-reports/3
curl -s 'http://127.0.0.1:3210/api/test-reports/3?format=md'

# 验收报告：聚合最近结果与通过率；分桶守恒，running/notRun 不计入分母；format=md 可直接贴 issue / MR
curl -s 'http://127.0.0.1:3210/api/nodes/1/acceptance-report?scope=subtree'
curl -s 'http://127.0.0.1:3210/api/nodes/1/acceptance-report?format=md'

# 验收签收：先看状态，再显式签收 / 驳回；签收绑定当前证据指纹，证据变化自动 stale
curl -s 'http://127.0.0.1:3210/api/nodes/1/acceptance-status?scope=subtree'
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/acceptance-signoff \
  -H 'content-type: application/json' -d '{"decision":"accepted","comment":"业务确认通过"}'

# CLI / MCP 等价入口
# node bin/taskboard.js test acceptance-status "项目A/需求1" [--scope self|subtree]
# node bin/taskboard.js test acceptance-sign "项目A/需求1" --decision accepted --comment "业务确认通过"
# MCP: acceptance_status { node, scope?, format? } / acceptance_sign { node, decision, scope?, comment? }

# CLI：单条报告导出（只读；非法 format 返回 VALIDATION_FAILED）
node bin/taskboard.js test report get 3 --format md

# MCP：test_report_get { id: 3, format: "md" }
```

## 上线治理（上线配置 / 上线 SQL / 上线检查清单）

```bash
# 按项名 upsert 上线项（幂等）：kind = config | sql | check
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/release-items/upsert \
  -H 'content-type: application/json' \
  -d '{"name":"执行上线 SQL","kind":"sql","content":"ALTER TABLE t ADD COLUMN x INT;","rollback":"ALTER TABLE t DROP COLUMN x;","required":true}'

# 上线配置 / 检查项
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/release-items/upsert \
  -H 'content-type: application/json' -d '{"name":"开灰度开关","kind":"config","content":"switch=on","rollback":"switch=off"}'

# 列表：按类型 / 状态筛，includeOptional=false 只看必做
curl -s 'http://127.0.0.1:3210/api/nodes/1/release-items?kind=sql'
curl -s 'http://127.0.0.1:3210/api/nodes/1/release-items?includeOptional=false'

# 回写状态（done / skipped 才算必做项完成）
curl -s -X PATCH http://127.0.0.1:3210/api/release-items/1 \
  -H 'content-type: application/json' -d '{"status":"done"}'

# 上线检查清单：完成度 + 就绪结论 + 阻塞项；format=md 可直接贴上线单
curl -s 'http://127.0.0.1:3210/api/nodes/1/release-checklist?scope=subtree'
curl -s 'http://127.0.0.1:3210/api/nodes/1/release-checklist?format=md'

# 就绪口径：必做项全部 done/skipped，且所有启用中的 code_check / biz_check / release_check
# 用例最近结论为 pass；running / not_run 都不算证据。既无必做项也无检查用例时 ready=null。
# 响应里 blockers=必做上线项，caseBlockers=检查用例（带 latestStatus / latestReportId）。
# 上线 SQL 风险审查：静态扫描 kind=sql 上线项正文
# DROP TABLE/DATABASE、TRUNCATE、无 WHERE 的 UPDATE/DELETE 阻塞；DROP COLUMN / 缺回滚只提示
curl -s http://127.0.0.1:3210/api/nodes/1/release-sql-audit
curl -s 'http://127.0.0.1:3210/api/nodes/1/release-sql-audit?scope=subtree'
curl -s 'http://127.0.0.1:3210/api/nodes/1/release-sql-audit?format=md'

# 上线前置检查：挑 code_check / biz_check / release_check 用例派单；dryRun 只回提示词
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/release-checks \
  -H 'content-type: application/json' -d '{"dryRun":true}'

# 连子树的上线项与检查用例一起纳入
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/release-checks \
  -H 'content-type: application/json' -d '{"scope":"subtree","dryRun":true}'
```

> **派单自动收尾**：`test-runs` / `release-checks` 开出的 `running` 报告，会在 agent 任务落终态时由
> `finalizeReportsForRun` 自动收尾。结论优先从 agent 输出解析 `用例名: PASS|FAIL|BLOCKED - 依据`；
> 解析不到该用例结论时按 run 终态回落：成功 → `blocked`（不伪造成 `pass`）、超时/取消 → `cancelled`、
> 失败 → `error`。自动结论打 `autoFinalized:true`，人工可直接改正（无需 `overwrite`）。

## 需求就绪门禁（需求管理闭环的前置判定）

```bash
# 门禁结论：需求内容 / 概要设计 / 可回归用例三条是否齐备
# 注：新建节点会预置**空白**「需求内容」文档，必须真正填写才算通过
curl -s http://127.0.0.1:3210/api/nodes/1/readiness

# 连子树的需求一起判定（挂在项目 / 需求上）
curl -s 'http://127.0.0.1:3210/api/nodes/1/readiness?scope=subtree'

# markdown 可直接贴进 issue / 评审记录
curl -s 'http://127.0.0.1:3210/api/nodes/1/readiness?format=md'

# CLI / MCP 等价入口
# node bin/taskboard.js readiness check "项目A/需求1" [--scope self|subtree] [--format json|md]
# MCP: requirement_readiness { node, scope?, format? }
```

> `scope` 只接受 `self` / `subtree`（缺省 = `self`）；其它取值（含 `Subtree` / 空串）返回
> `400 VALIDATION_FAILED`，**不会静默降级成 `self`**。同一规则适用于 `acceptance-report` /
> `release-checklist` / `release-sql-audit` / `delivery-gate` / `diffs` / `tracks` / `duplicates`。
> 空态：子树内没有需求时返回 `ready=null`（`totals.units=0`），不是 400。

## 概要设计大纲 / 思维导图（需求管理 → 概要设计 → 文档）

```bash
# 从需求树推导结构（JSON）：结构树 + 单元 / 节点计数
curl -s http://127.0.0.1:3210/api/nodes/1/design-outline

# markdown 骨架：含 mermaid 思维导图 + 逐层小节，可直接写入「概要设计」文档
curl -s 'http://127.0.0.1:3210/api/nodes/1/design-outline?format=md'

# 一键写入各需求的「概要设计」文档（默认不覆盖已有正文）
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/design-outline/apply \
  -H 'content-type: application/json' -d '{"scope":"self"}'

# 预演：只回报将写哪些，不落库、不动 revision（与 overwrite 同传也只预演）
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/design-outline/apply \
  -H 'content-type: application/json' -d '{"dryRun":true,"overwrite":true}'

# CLI / MCP 等价入口
# node bin/taskboard.js design outline "项目A/需求1" [--scope self|subtree] [--format json|md]
# node bin/taskboard.js design apply   "项目A/需求1" [--scope self|subtree] [--overwrite] [--dry-run]
# MCP: design_outline { node, scope?, format? } / design_outline_apply { node, scope?, overwrite?, dryRun? }
```

> 只对 `requirement` / `subreq` 推导；挂在项目上用 `scope=subtree` 逐需求各出一份。
> 文档名取 `config.readiness.designDoc`，与需求就绪门禁判定的是同一份文档 —— 写入后
> `design_doc` 门禁即通过。已有非空内容默认保留（`written:false / reason=already_filled`），
> 需要覆盖时显式传 `overwrite:true`。推导本身是纯读，不写库、不动 revision。

## 思维导图（树 → mermaid mindmap 的只读投影）

```bash
# 子树导图（JSON：mermaid 文本 + 结构化 nodes/edges/totals）
curl -s 'http://127.0.0.1:3210/api/nodes/1/mindmap?scope=subtree'

# 只画本节点
curl -s 'http://127.0.0.1:3210/api/nodes/1/mindmap?scope=self'

# 截断到第 1 层（totals.truncated 记被截断的子节点数）
curl -s 'http://127.0.0.1:3210/api/nodes/1/mindmap?scope=subtree&maxDepth=1'

# markdown：标题 + 统计 + mermaid 代码块，可直接贴 issue / 设计文档
curl -s 'http://127.0.0.1:3210/api/nodes/1/mindmap?scope=subtree&format=md'

# CLI / MCP 等价入口（CLI 为单层命令）
# node bin/taskboard.js mindmap "项目A/需求1" [--scope self|subtree] [--max-depth N] [--format json|md]
# MCP: mindmap { node, scope?, maxDepth?, format? }
```

> 导图是节点树的**只读投影**：不写库、不动 revision。标签里的 `"` / `&` 会被转义成实体，
> 空名用 `（未命名）` 占位。`maxDepth` 只接受 `0..50` 的整数，其它值（含空串）返回
> `400 VALIDATION_FAILED`，**不会静默截成只剩根节点**。Web 端对应节点抽屉的「导图」页签。
## 文档敏感信息扫描（只读安全前置判定）

```bash
# 扫描本节点非空文档里的凭据模式（命中值默认脱敏，不会回显原文）
curl -s http://127.0.0.1:3210/api/nodes/1/secret-scan

# 连子树一起扫描（挂在项目 / 需求上）
curl -s 'http://127.0.0.1:3210/api/nodes/1/secret-scan?scope=subtree'

# markdown 可直接贴进 issue / 评审记录
curl -s 'http://127.0.0.1:3210/api/nodes/1/secret-scan?format=md'

# CLI / MCP 等价入口
# node bin/taskboard.js secret scan "项目A/需求1" [--scope self|subtree] [--format json|md]
# MCP: secret_scan { node, scope?, format? }
```

> 扫描对象只含**非空文档**；没有可扫描内容时返回 `ready=null`，不是安全通过。
> 高危命中（PEM 私钥 / AWS / GitHub / Slack / JWT / 显式密钥赋值）阻塞并进入 `blockers`，
> `Bearer` 提示进入 `warnings` 但不阻塞。
> 所有证据只返回脱敏值与 `[REDACTED:<rule>]` 上下文；JSON / MCP / markdown 都不会回显凭据原文。
> 只读接口：不写库、不动 revision。

## 交付门禁（需求就绪 / 测试验收 / 上线治理的最终汇总）

```bash
# 单节点最终交付结论：来源为 readiness / acceptance / release 三段既有结论
curl -s http://127.0.0.1:3210/api/nodes/1/delivery-gate

# 连子树一起判定（挂在项目 / 需求上）
curl -s 'http://127.0.0.1:3210/api/nodes/1/delivery-gate?scope=subtree'

# markdown 可直接贴进 issue / 验收记录 / 上线单
curl -s 'http://127.0.0.1:3210/api/nodes/1/delivery-gate?format=md'

# CLI / MCP 等价入口
# node bin/taskboard.js delivery gate "项目A/需求1" [--scope self|subtree] [--format json|md]
# MCP: delivery_gate { node, scope?, format? }
```

> 三段证据全部适用且通过时 `decision=ready`；任一段未通过为 `not_ready`；
> 三段均不适用（没有需求 / 用例 / 必做上线项）时为 `unknown`，`ready=null`。
> `not_applicable` 既不阻塞也不算通过。
> `scope` / `format` 都是枚举：非法值返回 `400 VALIDATION_FAILED`，不会静默降级。
> 验收来源只聚合**启用中**的用例；停用用例不算 `notRun`、也不阻塞交付。
> 测试全部通过后仍需有效验收签收：`pending` / `rejected` / `stale` 都会阻塞交付，避免把测试绿灯冒充业务验收。

### 交付证据快照（验收留痕 / 上线审计）

实时交付门禁会随源数据变化；快照用于冻结“当时凭什么放行”。

```bash
# 冻结当前结论（保存完整证据与指纹）
curl -s -X POST http://127.0.0.1:3210/api/nodes/1/delivery-snapshots \
  -H 'content-type: application/json' \
  -d '{"scope":"self","note":"2026-09 上线批次"}'

# 列出快照：current = 与当前证据一致；drifted = 源数据已变化
curl -s 'http://127.0.0.1:3210/api/nodes/1/delivery-snapshots?scope=self'

# 单条快照；markdown 可直接贴进验收 / 上线记录
curl -s 'http://127.0.0.1:3210/api/delivery-snapshots/1?format=md'

# CLI / MCP 等价入口
# node bin/taskboard.js delivery snapshot "项目A/需求1" [--scope self|subtree] [--note <备注>]
# node bin/taskboard.js delivery snapshots "项目A/需求1" [--scope self|subtree] [--limit N]
# node bin/taskboard.js delivery snapshot-get <sid> [--format json|md]
# MCP: delivery_snapshot_capture / delivery_snapshot_list / delivery_snapshot_get
```

> `drifted` **不会改写冻结结论**：它只表示当时的证据已与现状不同。
> 验收 / 上线审计应同时看「冻结结论」与「当前核对」，不能拿快照冒充实时门禁。

## 错误码速查

| HTTP | code | 场景 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 必填/类型校验失败（`details` 指向字段）|
| 400 | `PARENT_TYPE_INVALID` | 父子类型非法 |
| 400 | `LEAF_NODE` | 在叶子节点下建子节点 |
| 400 | `CYCLE_DETECTED` | 移动到自身或后代 |
| 400 | `CONFIRM_REQUIRED` | 破坏性操作未确认 |
| 400 | `REPO_NOT_REGISTERED` / `REPO_PATH_MISSING` | 仓库未登记 / 本地路径无效 |
| 400 | `BRANCH_NOT_FOUND` / `BRANCH_EXISTS_DIFFERENT_BASE` | 分支不存在 / 同名不同基 |
| 400 | `GITLAB_NOT_CONFIGURED` | 未配置 GitLab |
| 404 | `NOT_FOUND` / `PATH_NOT_FOUND` | 资源或路径不存在 |
| 409 | `PATH_AMBIGUOUS` / `DOC_NAME_EXISTS` / `WORKTREE_PATH_EXISTS` | 路径歧义 / 文档重名 / worktree 占用 |
| 409 | `TEST_CASE_NAME_EXISTS` | 同节点测试用例重名 |
| 409 | `REPORT_STATUS_IMMUTABLE` | 报告终态互转 / 回退 running（`details` 带 current/next；`overwrite:true` 可覆盖） |
| 409 | `RELEASE_ITEM_NAME_EXISTS` | 同节点上线项重名（upsert 走幂等覆盖，不报错）|
| 500 | `GIT_UNAVAILABLE` / `GIT_FAILED` | 本机 git 不可用 / 命令失败（`details` 带 stderr）|
| 502 | `GITLAB_AUTH_FAILED` / `GITLAB_PROJECT_NOT_FOUND` / `GITLAB_UNAVAILABLE` | token 无效 / 项目路径错 / 网络异常 |

完整清单见 [`design.md` §9](./design.md) 与 `server/errors.mjs`。

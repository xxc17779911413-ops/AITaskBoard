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
> 未知 `projectId` / 未知项目路径一律返回**空态**（`requirementCount=0`、`items=[]`、`gaps=[]`），
> HTTP / CLI / MCP 三入口同口径，不再抛 `NOT_FOUND` / `PATH_NOT_FOUND`。
> 叠加 `q` / `docName` / `fill` 筛选后，顶部 KPI 取 `filteredDocumentCount` / `filteredGapCount`，与列表一致。

## 结构探索（需求树 + 文档/用例/验收状态）

```bash
# 需求树叠加「文档缺口 / 用例最近结论 / 需求就绪」状态；可按类型 / 状态 / 就绪 / 缺口 / 用例状态 / 关键词筛选
curl -s 'http://127.0.0.1:3210/api/nodes/1/structure-graph?scope=subtree'
curl -s 'http://127.0.0.1:3210/api/nodes/1/structure-graph?scope=subtree&hasGap=true'
curl -s 'http://127.0.0.1:3210/api/nodes/1/structure-graph?scope=subtree&caseStatus=not_run&format=md'

# CLI / MCP 等价入口
# node bin/taskboard.js structure graph "项目A" --scope subtree [--type requirement] [--status doing] [--ready false] [--has-gap true] [--case-status not_run] [--q 导出]
# MCP: structure_graph { node, scope?, type?, status?, ready?, hasGap?, caseStatus?, q?, format? }
```

> 只读投影：不写库、不动 revision。`caseStatus` 按最严重优先（`fail > running > not_run > pass`）；
> 筛选只影响展示，`totals.total` 是筛选前节点数、`totals.nodes` 是筛选后，`edges` 只保留两端都在结果集里的连接。
> `scope` / `type` / `status` / `ready` / `hasGap` / `caseStatus` / `format` 非法值一律 `400 VALIDATION_FAILED`。

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

重名 → `409`：

```json
{ "error": { "code": "DOC_NAME_EXISTS", "message": "节点下已存在文档「需求内容」" } }
```

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

# 报告列表 / 单条
curl -s 'http://127.0.0.1:3210/api/nodes/1/test-reports?limit=20'
curl -s http://127.0.0.1:3210/api/test-reports/3

# 验收报告：聚合最近结果与通过率；分桶守恒，running/notRun 不计入分母；format=md 可直接贴 issue / MR
curl -s 'http://127.0.0.1:3210/api/nodes/1/acceptance-report?scope=subtree'
curl -s 'http://127.0.0.1:3210/api/nodes/1/acceptance-report?format=md'
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
> `release-checklist` / `delivery-gate` / `diffs` / `tracks` / `duplicates`。
> 空态：子树内没有需求时返回 `ready=null`（`totals.units=0`），不是 400。

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

## 权限边界与操作审计

```bash
# 高风险操作（AI 通道需显式 confirm；人工通道默认放行）
curl -s -X POST http://127.0.0.1:3210/api/requirements/3/transition \
  -H 'content-type: application/json' -H 'x-taskboard-actor: ai' \
  -d '{"status":"doing","confirm":true}'

# AI 未确认 → 403 PERMISSION_DENIED（details.confirmRequired=true / auditId），且写入审计
curl -s -X POST http://127.0.0.1:3210/api/requirements/3/transition \
  -H 'content-type: application/json' -H 'x-taskboard-actor: ai' \
  -d '{"status":"doing"}'

# 查看审计日志（只读，倒序）
curl -s 'http://127.0.0.1:3210/api/audit-logs?decision=denied'
curl -s 'http://127.0.0.1:3210/api/audit-logs?action=release.item.write&nodeId=3'

# CLI / MCP 等价入口
# node bin/taskboard.js audit list [--action release.check|regression.run|requirement.transition|release.item.write] [--decision allowed|denied|confirmed|pending] [--node-id N]
# node bin/taskboard.js requirement transition "项目A/需求1" --status doing --actor ai --confirm
# MCP: audit_list { action?, nodeId?, decision?, limit? }；高风险 tool 传 confirm: true
```

> 四类高风险操作：`release.check`（上线检查派单）/ `regression.run`（回归派单）/
> `requirement.transition`（状态流转）/ `release.item.write`（配置·SQL 变更）。
> `dryRun` 预演不需要确认；闸门在真正的写操作 / 派单之前，被拒时不产生状态变更、报告或 agent 任务。
> 审计记录 `allowed` / `denied` / `confirmed`，只写审计表、不 bump revision。

## 错误码速查

| HTTP | code | 场景 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 必填/类型校验失败（`details` 指向字段）|
| 400 | `PARENT_TYPE_INVALID` | 父子类型非法 |
| 400 | `LEAF_NODE` | 在叶子节点下建子节点 |
| 400 | `CYCLE_DETECTED` | 移动到自身或后代 |
| 400 | `CONFIRM_REQUIRED` | 破坏性操作未确认 |
| 403 | `PERMISSION_DENIED` | AI/agent 触发高风险操作（上线检查 / 回归派单 / 状态流转 / 配置·SQL 变更）但未显式 `confirm`；人工通道默认放行 |
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

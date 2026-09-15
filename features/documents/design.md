# 设计：文档（documents）

## 1. 数据结构

`documents(id, node_id, name, content, sort, created_at, updated_at, created_by, updated_by)`：

- `UNIQUE(node_id, name)` —— 名称在同节点内唯一；`name` 是自由文本（不做枚举），rename 会改变引用，故 AI 侧建议用 `upsert` 而非改名。
- `idx_documents_node(node_id, sort)` —— 列表按 `sort` 升序、稳定。
- 外键 `node_id → nodes(id) ON DELETE CASCADE`：删节点连带删文档（`deleteNode` 的计数里已包含 `documents`）。

## 2. 关键规则

- **预置时机**：在 `createNode` 内、写属性之后，按 `createStore(db, { docPresets })` 注入的映射（默认值与 `config.docPresets` 一致）逐名 `upsertDocument(nodeId, name, '')`。
- **upsert 语义**：按 `(node_id, name)` 查；不存在走 `createDocument`；存在则仅当 `content !== null` 才更新内容，返回 `{ id, created, name }`。
- **改名查重**：`updateDocument` 改 `name` 时用 `id <> ?` 排除自身，命中别的文档才报 `DOC_NAME_EXISTS`。
- **排序**：与节点同级排序同一套路（`sort` 步长 10，事务内批量 `UPDATE`）。
- **审计与可见性**：所有写函数都记录 `actor(by)` 到 `created_by` / `updated_by` 并 `bumpRevision()`。

## 3. 对外接口

```js
listDocuments(nodeId)                      // → DocVO[]（按 sort, id）
createDocument(nodeId, name, content, by)  // → DocVO（重名/空名报错）
updateDocument(docId, { name?, content? }, by) // → DocVO
upsertDocument(nodeId, name, content, by)  // → { id, created, name }
deleteDocument(docId)                      // → { id }
reorderDocuments(nodeId, orderedIds)       // → DocVO[]
```

## 4. 错误码

`DOC_NAME_EXISTS`（同节点重名，`details.name`）、`VALIDATION_FAILED`（空名）、`NOT_FOUND`（文档不存在）。

## 5. 与主设计文档的对应

§4.6 的表结构与 `UNIQUE(node_id, name)`；§7.7 的「表格点 📄 数量 → 抽屉文档区」由计划 3 的 UI 消费这里的读写接口；§5.2 约定的「长文本一律走文档」即本功能存在的理由（属性只放结构化短字段）。

## 6. 文档管理聚合（纯读）

`store.documentOverview({ projectId, status, q, docName, fill })` 复用 `listRequirements()` 的节点范围与
`readiness.requirementDoc` / `readiness.designDoc` 口径：

- `items` 展平该项目/状态范围内的文档，附带需求路径、核心文档标记、正文预览与 `filled`。
- `gaps` 逐需求 × 逐核心文档计算缺口；`gapType=missing` 表示槽位未关联，`gapType=empty` 表示已关联但正文空白。
- `summary` 同时给出槽位总数、已关联、已填写、空白、未关联、缺口需求数与筛选后条数；筛选后的 `summary.filtered*` 与实际列表长度一致。
- `fill` 只接受 `filled|empty`，非法值 `VALIDATION_FAILED`；未知 `projectId` 返回空态而不是全库。
- **未知项目三入口统一**：`store.resolveProjectScope(ref)` 是项目引用的唯一解析点——命中 id / 路径返回其 id，未知 id / 未知路径返回空态（不再抛 `NOT_FOUND` / `PATH_NOT_FOUND`），空串表示不限定项目。HTTP / CLI / MCP 的 `documentOverview` 都传 `projectRef` 走这一条路径，保证同一入参在三入口得到逐字段一致的结论（歧义路径仍抛 `PATH_AMBIGUOUS`）。
- **筛选态 KPI**：`q` / `docName` / `fill` 任一存在时，Web 顶部「文档数 / 缺口」改用后端已返回的 `filteredDocumentCount` / `filteredGapCount`，与表格行数、缺口面板条数保持一致；无筛选时才展示 scope 级全量统计（`web/src/documentKpi.js`）。

HTTP / CLI / MCP 只做参数装配；Web 的「文档管理」页用该聚合做检索、缺口对账与需求定位，
点击后仍通过 `DocPane` 走原有文档编辑链路，避免第二套编辑器。

# 设计：文档（documents）

## 1. 数据结构

`documents(id, node_id, name, content, sort, created_at, updated_at, created_by, updated_by)`：

- `UNIQUE(node_id, name)` —— 名称在同节点内唯一；`name` 是自由文本（不做枚举），rename 会改变引用，故 AI 侧建议用 `upsert` 而非改名。
- `idx_documents_node(node_id, sort)` —— 列表按 `sort` 升序、稳定。
- 外键 `node_id → nodes(id) ON DELETE CASCADE`：删节点连带删文档（`deleteNode` 的计数里已包含 `documents`）。

## 2. 关键规则

- **预置时机**：在 `createNode` 内、写属性之后，按 `createStore(db, { docPresets })` 注入的映射（默认值与 `config.docPresets` 一致）逐名 `upsertDocument(nodeId, name, '')`。
- **upsert 语义**：按 `(node_id, name)` 查；不存在走 `createDocument`；存在则仅当 `content !== null` 才更新内容，返回 `{ id, created, name }`。
- **版本历史**：`document_versions` 保存每次创建 / 更新 / 恢复快照；恢复会追加新快照，旧版本不可变（详见 `history-design.md`）。
- **改名查重**：`updateDocument` 改 `name` 时用 `id <> ?` 排除自身，命中别的文档才报 `DOC_NAME_EXISTS`。
- **排序**：与节点同级排序同一套路（`sort` 步长 10，事务内批量 `UPDATE`）。
- **审计与可见性**：所有写函数都记录 `actor(by)` 到 `created_by` / `updated_by` 并 `bumpRevision()`。

## 2.1 文档历史与恢复

新增 `document_versions(id, document_id, name, content, reason, created_at, created_by)`，外键 `document_id → documents(id) ON DELETE CASCADE`，索引 `idx_document_versions_doc(document_id, id)`。

- **只追加**：`saveDocumentVersion` 只 `INSERT`，不更新或删除既有快照。
- **保存时机**：`createDocument` 落 `create`；`updateDocument` 落 `update`；恢复落 `restore`；老库回填落 `migrated`。
- **无差异不落**：`updateDocument({})`、只改空白名称且 trim 后同名、或正文完全未变化时直接返回当前文档，不写 `documents`、不追加快照、不递增 revision。
- **恢复语义**：先读取目标版本并检查同节点是否已有其它文档占用该名称，无冲突才更新 `documents`，随后保存 `restore` 新快照。
- **名称口径**：恢复前对快照名执行 `trim`，空名报 `VALIDATION_FAILED`；查重与写回都使用 trim 后的名称。
- **revision**：查询历史是纯读；恢复是一次写入，只 `bumpRevision()` 一次。
- **迁移**：`db.migrate()` 幂等建表，并对没有历史的文档按当前名称 / 正文 / `updated_by` / `updated_at` 回填 `migrated`。
- **数据快照**：文本快照的导出 / 导入顺序把 `document_versions` 紧跟在 `documents` 后；导入建立 `documents` 旧 id→新 id 映射后重写 `document_id`，找不到新文档的孤儿版本直接丢弃。

## 3. 对外接口

```js
listDocuments(nodeId)                      // → DocVO[]（按 sort, id）
createDocument(nodeId, name, content, by)  // → DocVO（重名/空名报错）
updateDocument(docId, { name?, content? }, by) // → DocVO
upsertDocument(nodeId, name, content, by)  // → { id, created, name }
deleteDocument(docId)                      // → { id }
reorderDocuments(nodeId, orderedIds)       // → DocVO[]
listDocumentVersions(docId)                // → VersionVO[]（新→旧）
restoreDocumentVersion(docId, versionId, by) // → { document, version }
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

HTTP / CLI / MCP 只做参数装配；Web 的「文档管理」页用该聚合做检索、缺口对账与需求定位，
点击后仍通过 `DocPane` 走原有文档编辑链路，避免第二套编辑器。

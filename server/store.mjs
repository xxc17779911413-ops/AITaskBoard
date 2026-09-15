import { createHash } from 'node:crypto'
import { AppError, CODES } from './errors.mjs'
import { CHILD_TYPES, LEAF_TYPES } from './db.mjs'

// actor 值域：写操作审计字段的允许值。'mcp' 与 'ai' 都表示「AI 经 MCP 写入」——
// 历史工具传 'ai'，部分工具传 'mcp'；'mcp' 此前不在值域内会被静默降级成 'user'，
// 让 AI 写的文档在审计上冒充「用户写的」。两个值都保留，避免历史审计语义被改写，
// 新工具统一用 'mcp'。非法值仍回退 'user'（见 actor()）。
const ACTORS = new Set(['user', 'ai', 'cli', 'import', 'mcp'])
const now = () => new Date().toISOString()
const REVIEW_STATUSES = ['pending', 'approved', 'issue']
const MERGE_STATES = ['precheck_conflict', 'merged', 'resolved', 'aborted']

/**
 * scope 枚举值域。所有聚合类接口（需求就绪 / 验收报告 / 上线清单 / 交付门禁 / 上线检查派单）
 * 共用这一份值域与校验——**非法值必须报错，不能静默降级成 self**。
 *
 * 静默降级是放行门禁类接口最危险的失败模式：`scope=Subtree`（大小写错）会被吞成 `self`，
 * 让「子树未就绪」被汇报成 `ready=true`，调用方带着未就绪需求进入回归/上线。
 */
const SCOPE_VALUES = ['self', 'subtree']
const FORMAT_VALUES = ['json', 'md']

/**
 * scope 解析：缺省（undefined / null）→ fallback；其余必须在值域内，否则 VALIDATION_FAILED。
 * 注意 `''`（如 HTTP `?scope=`）属于「显式给了非法值」，按要求拒绝，不当作缺省。
 */
function normalizeScope(scope, fallback = 'self') {
  if (scope === undefined || scope === null) return fallback
  const v = String(scope)
  if (!SCOPE_VALUES.includes(v)) {
    throw new AppError(CODES.VALIDATION_FAILED, `未知 scope ${scope}`, { scope, allowed: SCOPE_VALUES })
  }
  return v
}

/**
 * format 解析：缺省（undefined / null）→ fallback；其余必须在值域内，否则 VALIDATION_FAILED。
 * 与 scope 同一条纪律——非法参数不得静默降级成 json，否则调用方会拿到结构不符的“成功”响应。
 */
function normalizeFormat(format, fallback = 'json') {
  if (format === undefined || format === null) return fallback
  const v = String(format)
  if (!FORMAT_VALUES.includes(v)) {
    throw new AppError(CODES.VALIDATION_FAILED, `未知 format ${format}`, { format, allowed: FORMAT_VALUES })
  }
  return v
}

/** 写事务抢锁失败时的兜底重试（busy_timeout 之外的保险） */
const SQLITE_BUSY_RETRIES = 5
const SQLITE_BUSY_RETRY_MS = 40
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const isSqliteBusy = (e) => /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String((e && e.message) || e))
/** 任务默认重试上限（含首次执行）：attempt 1 → 最多可重试到 3；超限重试被硬性拒绝 */
const DEFAULT_MAX_ATTEMPTS = 3

/** 预置文档名（与 config.docPresets 默认值一致） */
const DEFAULT_DOC_PRESETS = {
  project: ['描述'],
  requirement: ['需求内容'],
  subreq: ['需求内容'],
  group: [],
  task: [],
  defect: ['描述', '复现步骤']
}

/**
 * 需求就绪门禁口径（与 config.readiness 默认值一致）。
 * 门禁只判「需求两层」：项目不承载需求正文，任务组 / 子任务 / 缺陷是拆分产物。
 */
const DEFAULT_READINESS = {
  requirementDoc: '需求内容',
  designDoc: '概要设计',
  caseKinds: ['regression', 'acceptance']
}

/**
 * 需求管理的状态机。nodes.status 仍是底层字段，通用入口可改其它节点；
 * requirement 的业务流转必须走这里：待开始 → 进行中 → 提测中 → 已完成，
 * 未完成前可取消，误取消可通过 cancelled → todo 恢复。
 */
const REQUIREMENT_TRANSITIONS = {
  todo: ['doing', 'cancelled'],
  doing: ['testing', 'cancelled'],
  testing: ['done', 'cancelled'],
  done: [],
  cancelled: ['todo']
}
const DEFAULT_REQUIREMENT_STATUSES = Object.keys(REQUIREMENT_TRANSITIONS)

/**
 * 解析 agent 输出里的逐条测试结论。
 * 契约来自 ops.composeTestPrompt / composeReleaseCheckPrompt：
 *   `<用例名>: PASS|FAIL|BLOCKED - <依据>`
 * 刻意宽容：允许行首的 markdown 列表符号 / 序号 / 引号，结论大小写不敏感，
 * 也接受全角冒号与中文结论词（通过 / 失败 / 阻塞）。同一用例重复出现时取最后一条。
 */
const VERDICT_PATTERN = /^[\s>*\-•\d.、)"'`]*([^:：\n]+?)\s*[:：]\s*(PASS|FAIL|BLOCKED|通过|失败|阻塞)(?![A-Za-z])\s*(?:[-—–:：]\s*(.*))?$/i
const VERDICT_BY_WORD = {
  pass: 'pass',
  通过: 'pass',
  fail: 'fail',
  失败: 'fail',
  blocked: 'blocked',
  阻塞: 'blocked'
}

function normalizeVerdictKey(name) {
  return String(name == null ? '' : name)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function parseRunVerdicts(text) {
  const out = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(VERDICT_PATTERN)
    if (!m) continue
    const key = normalizeVerdictKey(m[1])
    if (!key) continue
    const status = VERDICT_BY_WORD[String(m[2]).toLowerCase()]
    if (!status) continue
    out.set(key, { status, note: (m[3] || '').trim() || null, raw: line.trim() })
  }
  return out
}

export function createStore(db, options = {}) {
  const docPresets = options.docPresets || DEFAULT_DOC_PRESETS
  const readiness = options.readiness || DEFAULT_READINESS
  const requirementStatuses = Array.isArray(options.status?.allowed?.requirement) && options.status.allowed.requirement.length
    ? options.status.allowed.requirement.map(String)
    : DEFAULT_REQUIREMENT_STATUSES
  const requirementStatusSet = new Set(requirementStatuses)
  const stmt = (sql) => db.prepare(sql)

  let bumpDepth = 0

  function bumpRevision() {
    if (bumpDepth > 0) return // 组合写入期间只算一次（见 withoutBump）
    db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run()
  }

  /** 把一组内部写入合并成一次 revision 递增（一次用户/AI 操作 = 一次递增） */
  function withoutBump(fn) {
    bumpDepth += 1
    try {
      return fn()
    } finally {
      bumpDepth -= 1
    }
  }
  function getRevision() {
    return Number(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get().value)
  }
  function actor(a) {
    return ACTORS.has(a) ? a : 'user'
  }

  function subtreeIds(rootId) {
    return db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE id = ?
           UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
         ) SELECT id FROM sub`
      )
      .all(rootId)
      .map((r) => r.id)
  }

  function rawNode(id) {
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id)
    if (!row) throw new AppError(CODES.NOT_FOUND, `节点 ${id} 不存在`, { id })
    return row
  }

  function buildPath(id) {
    const names = []
    let cur = id
    while (cur != null) {
      const row = db.prepare('SELECT id,name,parent_id FROM nodes WHERE id = ?').get(cur)
      if (!row) break
      names.unshift(row.name)
      cur = row.parent_id
    }
    return names.join('/')
  }

  function nodeVO(row) {
    return {
      id: row.id,
      type: row.type,
      parentId: row.parent_id,
      name: row.name,
      status: row.status,
      sort: row.sort,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      path: buildPath(row.id)
    }
  }

  function validateParent(type, parentId) {
    if (!Object.prototype.hasOwnProperty.call(CHILD_TYPES, type)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知节点类型 ${type}`, { type })
    }
    if (parentId == null) {
      if (type !== 'project') {
        throw new AppError(CODES.PARENT_TYPE_INVALID, `只有 project 可以没有父节点，${type} 必须挂在父节点下`, { type })
      }
      return null
    }
    const parent = rawNode(parentId)
    const allowedChildren = CHILD_TYPES[parent.type] || []
    if (allowedChildren.length === 0) {
      throw new AppError(CODES.LEAF_NODE, `${parent.type} 是叶子节点，不能再挂子节点`, { parentId })
    }
    if (!allowedChildren.includes(type)) {
      throw new AppError(CODES.PARENT_TYPE_INVALID, `${parent.type} 下不能挂 ${type}`, {
        type,
        parentType: parent.type,
        allowedChildren
      })
    }
    return parent
  }

  function createNode({ parentId = null, type, name, status = 'todo', attrs, actor: by = 'user' }) {
    if (!type) throw new AppError(CODES.VALIDATION_FAILED, 'type 必填')
    if (!name || !String(name).trim()) throw new AppError(CODES.VALIDATION_FAILED, 'name 必填', { field: 'name' })
    const initialStatus = type === 'requirement' ? assertRequirementCreateStatus(status) : status
    validateParent(type, parentId)
    const ts = now()
    const nextSort = db
      .prepare('SELECT IFNULL(MAX(sort),0) + 10 s FROM nodes WHERE IFNULL(parent_id,0) = IFNULL(?,0)')
      .get(parentId).s
    const info = db
      .prepare(
        'INSERT INTO nodes (type,parent_id,name,status,sort,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(type, parentId, String(name).trim(), initialStatus, nextSort, ts, ts, actor(by), actor(by))
    const id = Number(info.lastInsertRowid)
    // 建节点 + 写属性 + 预置文档属于「一次操作」，只递增一次 revision
    withoutBump(() => {
      if (attrs) setAttrs(id, attrs, by)
      const names = type === 'requirement'
        ? [...new Set([...docPresetNames(type), ...requirementDocNames()])]
        : docPresetNames(type)
      for (const docName of names) upsertDocument(id, docName, '', by)
    })
    bumpRevision()
    return nodeVO(rawNode(id))
  }

  const docPresetNames = (type) => docPresets[type] || []

  function assertRequirementStatus(status) {
    if (!requirementStatusSet.has(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知需求状态 ${status}`, {
        status,
        allowed: [...requirementStatusSet]
      })
    }
    return status
  }

  function assertRequirementCreateStatus(status = 'todo') {
    assertRequirementStatus(status)
    if (status !== 'todo') {
      throw new AppError(CODES.VALIDATION_FAILED, `需求创建时状态必须是 todo，收到 ${status}`, {
        status,
        allowed: ['todo']
      })
    }
    return 'todo'
  }

  function canTransitionRequirement(from, to) {
    return (REQUIREMENT_TRANSITIONS[from] || []).includes(to)
  }

  const requirementDocNames = () => [
    readiness.requirementDoc || DEFAULT_READINESS.requirementDoc,
    readiness.designDoc || DEFAULT_READINESS.designDoc
  ]

  function requirementDocState(nodeId) {
    const docs = listDocuments(nodeId)
    return requirementDocNames().map((name) => {
      const doc = docs.find((d) => d.name === name) || null
      return {
        name,
        documentId: doc ? doc.id : null,
        contentLength: doc ? String(doc.content || '').trim().length : 0,
        linked: !!doc,
        filled: !!doc && String(doc.content || '').trim() !== ''
      }
    })
  }

  function requirementVO(row) {
    const node = nodeVO(row)
    const parent = row.parent_id == null ? null : rawNode(row.parent_id)
    const readiness = node.type === 'requirement' ? buildRequirementReadiness(node.id, { scope: 'self' }) : null
    return {
      ...node,
      projectId: parent && parent.type === 'project' ? parent.id : null,
      projectName: parent && parent.type === 'project' ? parent.name : null,
      attrs: getAttrs(node.id),
      documents: listDocuments(node.id),
      docState: requirementDocState(node.id),
      readiness,
      canTransitionTo: REQUIREMENT_TRANSITIONS[node.status] || []
    }
  }

  function listRequirements({ projectId = null, status = null } = {}) {
    const where = ["n.type = 'requirement'"]
    const args = []
    if (projectId != null) {
      where.push('n.parent_id = ?')
      args.push(projectId)
    }
    if (status) {
      assertRequirementStatus(status)
      where.push('n.status = ?')
      args.push(status)
    }
    const rows = db
      .prepare(`SELECT n.* FROM nodes n WHERE ${where.join(' AND ')} ORDER BY n.sort, n.id`)
      .all(...args)
    return rows.map((r) => requirementVO(r))
  }

  function createRequirement({ projectId, name, attrs, actor: by = 'user' }) {
    if (projectId == null) throw new AppError(CODES.VALIDATION_FAILED, 'projectId 必填', { field: 'projectId' })
    const node = createNode({ parentId: projectId, type: 'requirement', name, attrs, actor: by })
    return requirementVO(rawNode(node.id))
  }

  function transitionRequirement(nodeId, { status, actor: by = 'user' } = {}) {
    const cur = rawNode(nodeId)
    if (cur.type !== 'requirement') {
      throw new AppError(CODES.VALIDATION_FAILED, `节点 ${cur.id} 不是需求条目`, { nodeId: cur.id, nodeType: cur.type })
    }
    if (!Object.prototype.hasOwnProperty.call(REQUIREMENT_TRANSITIONS, status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知需求状态 ${status}`, {
        status,
        allowed: Object.keys(REQUIREMENT_TRANSITIONS)
      })
    }
    if (!Object.prototype.hasOwnProperty.call(REQUIREMENT_TRANSITIONS, cur.status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `需求当前状态 ${cur.status} 不在受控流转图内`, {
        status: cur.status,
        allowed: Object.keys(REQUIREMENT_TRANSITIONS)
      })
    }
    if (cur.status === status) return requirementVO(cur)
    if (!canTransitionRequirement(cur.status, status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `需求不能从 ${cur.status} 流转到 ${status}`, {
        from: cur.status,
        to: status,
        allowed: REQUIREMENT_TRANSITIONS[cur.status] || []
      })
    }
    updateNode(nodeId, { status }, by, { allowRequirementTransition: true })
    return requirementVO(rawNode(nodeId))
  }

  function requirementSummary({ projectId = null, status = null } = {}) {
    const items = listRequirements({ projectId, status })
    const byStatus = {}
    for (const key of requirementStatuses) byStatus[key] = 0
    let missingRequirementDoc = 0
    let missingDesignDoc = 0
    for (const item of items) {
      if (Object.prototype.hasOwnProperty.call(byStatus, item.status)) byStatus[item.status] += 1
      const [requirementDoc, designDoc] = requirementDocNames()
      if (!item.docState.find((d) => d.name === requirementDoc).filled) missingRequirementDoc += 1
      if (!item.docState.find((d) => d.name === designDoc).filled) missingDesignDoc += 1
    }
    return {
      total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
      byStatus,
      missingRequirementDoc,
      missingDesignDoc
    }
  }

  function updateNode(id, patch, by = 'user', options = {}) {
    const cur = rawNode(id)
    const fields = []
    const args = []
    if (patch.name !== undefined) {
      if (!String(patch.name).trim()) throw new AppError(CODES.VALIDATION_FAILED, 'name 不能为空', { field: 'name' })
      fields.push('name = ?')
      args.push(String(patch.name).trim())
    }
    if (patch.status !== undefined) {
      if (cur.type === 'requirement') assertRequirementStatus(patch.status)
      if (
        cur.type === 'requirement' &&
        !options.allowRequirementTransition &&
        patch.status !== cur.status &&
        Object.prototype.hasOwnProperty.call(REQUIREMENT_TRANSITIONS, cur.status) &&
        Object.prototype.hasOwnProperty.call(REQUIREMENT_TRANSITIONS, patch.status) &&
        !canTransitionRequirement(cur.status, patch.status)
      ) {
        throw new AppError(CODES.VALIDATION_FAILED, `需求不能从 ${cur.status} 流转到 ${patch.status}`, {
          from: cur.status,
          to: patch.status,
          allowed: REQUIREMENT_TRANSITIONS[cur.status] || []
        })
      }
      fields.push('status = ?')
      args.push(patch.status)
    }
    if (patch.parentId !== undefined) {
      if (patch.parentId === id) throw new AppError(CODES.CYCLE_DETECTED, '不能移动到自己下面')
      if (patch.parentId != null) {
        if (subtreeIds(id).includes(patch.parentId)) {
          throw new AppError(CODES.CYCLE_DETECTED, '不能移动到自己的后代下面', { id, parentId: patch.parentId })
        }
        validateParent(cur.type, patch.parentId)
      } else {
        validateParent(cur.type, null)
      }
      fields.push('parent_id = ?')
      args.push(patch.parentId)
    }
    fields.push('updated_at = ?', 'updated_by = ?')
    args.push(now(), actor(by))
    args.push(id)
    db.prepare(`UPDATE nodes SET ${fields.join(', ')} WHERE id = ?`).run(...args)
    if (patch.attrs) setAttrs(id, patch.attrs, by)
    bumpRevision()
    return nodeVO(rawNode(id))
  }

  function deleteNode(id) {
    rawNode(id)
    const ids = subtreeIds(id)
    const placeholders = ids.map(() => '?').join(',')
    const counts = {
      documents: db.prepare(`SELECT COUNT(*) c FROM documents WHERE node_id IN (${placeholders})`).get(...ids).c,
      documentVersions: db
        .prepare(
          `SELECT COUNT(*) c FROM document_versions WHERE document_id IN (
             SELECT id FROM documents WHERE node_id IN (${placeholders})
           )`
        )
        .get(...ids).c,
      attrValues: db.prepare(`SELECT COUNT(*) c FROM attr_values WHERE node_id IN (${placeholders})`).get(...ids).c,
      commits: db.prepare(`SELECT COUNT(*) c FROM commits WHERE node_id IN (${placeholders})`).get(...ids).c,
      mrs: db.prepare(`SELECT COUNT(*) c FROM mrs WHERE node_id IN (${placeholders})`).get(...ids).c,
      merges: db.prepare(`SELECT COUNT(*) c FROM merges WHERE node_id IN (${placeholders})`).get(...ids).c
    }
    db.prepare('DELETE FROM nodes WHERE id = ?').run(id)
    bumpRevision()
    return { nodes: ids.length, ...counts }
  }

  function listChildren(parentId) {
    const rows =
      parentId == null
        ? db.prepare('SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY sort, id').all()
        : db.prepare('SELECT * FROM nodes WHERE parent_id = ? ORDER BY sort, id').all(parentId)
    return rows.map((r) => ({
      ...nodeVO(r),
      childCount: db.prepare('SELECT COUNT(*) c FROM nodes WHERE parent_id = ?').get(r.id).c
    }))
  }

  function listTree() {
    // 一次聚合查出每个节点的文档数与直接子节点数（表格列展示用，避免每行单独查询）
    const docCounts = new Map(
      db.prepare('SELECT node_id, COUNT(*) c FROM documents GROUP BY node_id').all().map((r) => [r.node_id, r.c])
    )
    const childCounts = new Map(
      db
        .prepare('SELECT parent_id, COUNT(*) c FROM nodes WHERE parent_id IS NOT NULL GROUP BY parent_id')
        .all()
        .map((r) => [r.parent_id, r.c])
    )
    const all = db
      .prepare('SELECT * FROM nodes ORDER BY sort, id')
      .all()
      .map((r) => ({
        ...nodeVO(r),
        children: [],
        docCount: docCounts.get(r.id) || 0,
        childCount: childCounts.get(r.id) || 0
      }))
    const byId = new Map(all.map((n) => [n.id, n]))
    const roots = []
    for (const n of all) {
      if (n.parentId == null) roots.push(n)
      else byId.get(n.parentId)?.children.push(n)
    }
    return roots
  }

  function resolveRef(ref) {
    const asText = String(ref ?? '').trim()
    if (asText === '') throw new AppError(CODES.PATH_NOT_FOUND, '引用为空', { ref })
    if (/^\d+$/.test(asText)) return nodeVO(rawNode(Number(asText)))

    const parts = asText.split('/').map((s) => s.trim()).filter(Boolean)
    let candidates = db.prepare('SELECT * FROM nodes WHERE parent_id IS NULL').all()
    let cur = null
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i]
      const matched = candidates.filter((n) => n.name === name)
      const walked = parts.slice(0, i + 1).join('/')
      if (matched.length === 0) {
        throw new AppError(CODES.PATH_NOT_FOUND, `路径不存在：${walked}`, { ref })
      }
      if (matched.length > 1) {
        throw new AppError(CODES.PATH_AMBIGUOUS, `路径歧义：${walked}，请改用 id 引用`, {
          ref,
          matchedIds: matched.map((m) => m.id)
        })
      }
      cur = matched[0]
      candidates = db.prepare('SELECT * FROM nodes WHERE parent_id = ?').all(cur.id)
    }
    return nodeVO(cur)
  }

  function reorderSiblings(parentId, orderedIds) {
    const ts = now()
    const upd = db.prepare('UPDATE nodes SET sort = ?, updated_at = ? WHERE id = ?')
    db.exec('BEGIN')
    try {
      orderedIds.forEach((id, idx) => upd.run((idx + 1) * 10, ts, id))
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    bumpRevision()
    return listChildren(parentId)
  }

  const DATA_TYPES = new Set(['text', 'textarea', 'number', 'date', 'select', 'url'])

  function defVO(r) {
    return {
      id: r.id,
      nodeType: r.node_type,
      key: r.key,
      label: r.label,
      dataType: r.data_type,
      options: r.options ? JSON.parse(r.options) : null,
      required: !!r.required,
      defaultValue: r.default_value,
      sort: r.sort,
      enabled: !!r.enabled
    }
  }

  function listAttrDefs(nodeType, { includeDisabled = false } = {}) {
    const rows = nodeType
      ? db.prepare('SELECT * FROM attr_defs WHERE node_type = ? ORDER BY sort, id').all(nodeType)
      : db.prepare('SELECT * FROM attr_defs ORDER BY node_type, sort, id').all()
    return rows.map(defVO).filter((d) => includeDisabled || d.enabled)
  }

  function addAttrDef({
    nodeType,
    key,
    label,
    dataType = 'text',
    options = null,
    required = false,
    defaultValue = null,
    sort = 100
  }) {
    if (!nodeType || !key || !label) throw new AppError(CODES.VALIDATION_FAILED, 'nodeType / key / label 必填')
    if (!DATA_TYPES.has(dataType)) throw new AppError(CODES.VALIDATION_FAILED, `不支持的 dataType ${dataType}`, { dataType })
    const dup = db.prepare('SELECT id FROM attr_defs WHERE node_type = ? AND key = ?').get(nodeType, key)
    if (dup) throw new AppError(CODES.VALIDATION_FAILED, `${nodeType} 下已存在属性 ${key}`, { key })
    const ts = now()
    const info = db
      .prepare(
        'INSERT INTO attr_defs (node_type,key,label,data_type,options,required,default_value,sort,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)'
      )
      .run(
        nodeType,
        key,
        label,
        dataType,
        options ? JSON.stringify(options) : null,
        required ? 1 : 0,
        defaultValue,
        sort,
        ts,
        ts
      )
    bumpRevision()
    return defVO(db.prepare('SELECT * FROM attr_defs WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function updateAttrDef(id, patch) {
    const cur = db.prepare('SELECT * FROM attr_defs WHERE id = ?').get(id)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `属性定义 ${id} 不存在`, { id })
    const fields = []
    const args = []
    if (patch.label !== undefined) {
      fields.push('label = ?')
      args.push(patch.label)
    }
    if (patch.dataType !== undefined) {
      if (!DATA_TYPES.has(patch.dataType)) {
        throw new AppError(CODES.VALIDATION_FAILED, `不支持的 dataType ${patch.dataType}`)
      }
      fields.push('data_type = ?')
      args.push(patch.dataType)
    }
    if (patch.options !== undefined) {
      fields.push('options = ?')
      args.push(patch.options ? JSON.stringify(patch.options) : null)
    }
    if (patch.required !== undefined) {
      fields.push('required = ?')
      args.push(patch.required ? 1 : 0)
    }
    if (patch.defaultValue !== undefined) {
      fields.push('default_value = ?')
      args.push(patch.defaultValue)
    }
    if (patch.sort !== undefined) {
      fields.push('sort = ?')
      args.push(patch.sort)
    }
    if (patch.enabled !== undefined) {
      fields.push('enabled = ?')
      args.push(patch.enabled ? 1 : 0)
    }
    fields.push('updated_at = ?')
    args.push(now(), id)
    db.prepare(`UPDATE attr_defs SET ${fields.join(', ')} WHERE id = ?`).run(...args)
    bumpRevision()
    return defVO(db.prepare('SELECT * FROM attr_defs WHERE id = ?').get(id))
  }

  function deleteAttrDef(id) {
    const cur = db.prepare('SELECT id FROM attr_defs WHERE id = ?').get(id)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `属性定义 ${id} 不存在`, { id })
    db.prepare('DELETE FROM attr_defs WHERE id = ?').run(id)
    bumpRevision()
    return { id }
  }

  function validateValue(def, value) {
    if (value == null || value === '') {
      if (def.required) {
        throw new AppError(CODES.VALIDATION_FAILED, `属性「${def.label}」必填`, { key: def.key, required: true })
      }
      return null
    }
    const v = String(value)
    if (def.dataType === 'number' && Number.isNaN(Number(v))) {
      throw new AppError(CODES.VALIDATION_FAILED, `属性「${def.label}」必须是数字`, { key: def.key, value: v })
    }
    if (def.dataType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new AppError(CODES.VALIDATION_FAILED, `属性「${def.label}」必须是 YYYY-MM-DD`, { key: def.key, value: v })
    }
    if (def.dataType === 'select') {
      const allowed = (def.options || []).map((o) => String(o.value))
      if (!allowed.includes(v)) {
        throw new AppError(CODES.VALIDATION_FAILED, `属性「${def.label}」必须是 ${allowed.join(' / ')} 之一`, {
          key: def.key,
          value: v
        })
      }
    }
    return v
  }

  function setAttrs(nodeId, attrs, by = 'user') {
    const node = rawNode(nodeId)
    const defs = new Map(listAttrDefs(node.type).map((d) => [d.key, d]))
    const ts = now()
    db.exec('BEGIN')
    try {
      for (const [key, raw] of Object.entries(attrs || {})) {
        const def = defs.get(key)
        if (!def) throw new AppError(CODES.VALIDATION_FAILED, `属性 ${key} 不在 ${node.type} 的启用定义里（或已停用）`, { key })
        const value = validateValue(def, raw)
        const existing = db.prepare('SELECT id FROM attr_values WHERE node_id = ? AND attr_def_id = ?').get(nodeId, def.id)
        if (existing) {
          db.prepare('UPDATE attr_values SET value = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
            value,
            ts,
            actor(by),
            existing.id
          )
        } else {
          db.prepare('INSERT INTO attr_values (node_id,attr_def_id,value,updated_at,updated_by) VALUES (?,?,?,?,?)').run(
            nodeId,
            def.id,
            value,
            ts,
            actor(by)
          )
        }
      }
      db.prepare('UPDATE nodes SET updated_at = ?, updated_by = ? WHERE id = ?').run(ts, actor(by), nodeId)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    bumpRevision()
    return getAttrs(nodeId)
  }

  function getAttrs(nodeId) {
    rawNode(nodeId)
    const rows = db
      .prepare(
        `SELECT d.key, d.label, d.data_type, d.options, v.value, v.updated_at, v.updated_by
           FROM attr_values v JOIN attr_defs d ON d.id = v.attr_def_id
          WHERE v.node_id = ?`
      )
      .all(nodeId)
    const out = {}
    for (const r of rows) out[r.key] = r.value
    Object.defineProperty(out, '__meta', {
      enumerable: false,
      value: Object.fromEntries(
        rows.map((r) => [
          r.key,
          { label: r.label, dataType: r.data_type, updatedAt: r.updated_at, updatedBy: r.updated_by }
        ])
      )
    })
    return out
  }

  function docVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      name: r.name,
      content: r.content,
      sort: r.sort,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: r.created_by,
      updatedBy: r.updated_by
    }
  }

  function documentVersionVO(r) {
    return {
      id: r.id,
      documentId: r.document_id,
      name: r.name,
      content: r.content,
      reason: r.reason,
      createdAt: r.created_at,
      createdBy: r.created_by
    }
  }

  /**
   * 保存文档快照。快照只追加，不修改，恢复历史版本也会形成一条新快照，
   * 这样历史链能够完整解释每次文档状态的变化。
   */
  function saveDocumentVersion(row, reason = 'update') {
    const info = db
      .prepare(
        'INSERT INTO document_versions (document_id,name,content,reason,created_at,created_by) VALUES (?,?,?,?,?,?)'
      )
      .run(row.id, row.name, row.content ?? '', reason, now(), row.updated_by || row.created_by || 'user')
    return documentVersionVO(db.prepare('SELECT * FROM document_versions WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function listDocumentVersions(docId) {
    const cur = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `文档 ${docId} 不存在`, { id: docId })
    return db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY id DESC').all(docId).map(documentVersionVO)
  }

  function restoreDocumentVersion(docId, versionId, by = 'user') {
    const cur = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `文档 ${docId} 不存在`, { id: docId })
    const version = db.prepare('SELECT * FROM document_versions WHERE id = ? AND document_id = ?').get(versionId, docId)
    if (!version) throw new AppError(CODES.NOT_FOUND, `文档版本 ${versionId} 不存在`, { id: versionId, documentId: docId })
    const targetName = String(version.name || '').trim()
    if (!targetName) throw new AppError(CODES.VALIDATION_FAILED, '文档名必填', { field: 'name' })
    const duplicate = db
      .prepare('SELECT id FROM documents WHERE node_id = ? AND name = ? AND id <> ?')
      .get(cur.node_id, targetName, docId)
    if (duplicate) {
      throw new AppError(CODES.DOC_NAME_EXISTS, `节点下已存在文档「${targetName}」`, {
        nodeId: cur.node_id,
        name: targetName
      })
    }
    const ts = now()
    const byActor = actor(by)
    db.prepare('UPDATE documents SET name = ?, content = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
      targetName,
      version.content ?? '',
      ts,
      byActor,
      docId
    )
    const restored = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)
    const snapshot = saveDocumentVersion(restored, 'restore')
    bumpRevision()
    return { document: docVO(restored), version: snapshot }
  }

  function listDocuments(nodeId) {
    rawNode(nodeId)
    return db.prepare('SELECT * FROM documents WHERE node_id = ? ORDER BY sort, id').all(nodeId).map(docVO)
  }

  function createDocument(nodeId, name, content = '', by = 'user') {
    rawNode(nodeId)
    const docName = String(name || '').trim()
    if (!docName) throw new AppError(CODES.VALIDATION_FAILED, '文档名必填', { field: 'name' })
    const dup = db.prepare('SELECT id FROM documents WHERE node_id = ? AND name = ?').get(nodeId, docName)
    if (dup) throw new AppError(CODES.DOC_NAME_EXISTS, `节点下已存在文档「${docName}」`, { nodeId, name: docName })
    const ts = now()
    const sort = db.prepare('SELECT IFNULL(MAX(sort),0) + 10 s FROM documents WHERE node_id = ?').get(nodeId).s
    const info = db
      .prepare(
        'INSERT INTO documents (node_id,name,content,sort,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(nodeId, docName, String(content ?? ''), sort, ts, ts, actor(by), actor(by))
    const created = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(info.lastInsertRowid))
    saveDocumentVersion(created, 'create')
    bumpRevision()
    return docVO(created)
  }

  function updateDocument(docId, patch, by = 'user') {
    const cur = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `文档 ${docId} 不存在`, { id: docId })
    const nextName = patch.name !== undefined ? String(patch.name || '').trim() : null
    const nextContent = patch.content !== undefined ? String(patch.content ?? '') : null
    if (patch.name !== undefined && !nextName) {
      throw new AppError(CODES.VALIDATION_FAILED, '文档名必填', { field: 'name' })
    }
    const nameChanged = patch.name !== undefined && nextName !== cur.name
    const contentChanged = patch.content !== undefined && nextContent !== cur.content
    if (!nameChanged && !contentChanged) return docVO(cur)
    const fields = []
    const args = []
    if (nameChanged) {
      const dup = db
        .prepare('SELECT id FROM documents WHERE node_id = ? AND name = ? AND id <> ?')
        .get(cur.node_id, nextName, docId)
      if (dup) throw new AppError(CODES.DOC_NAME_EXISTS, `节点下已存在文档「${nextName}」`, { name: nextName })
      fields.push('name = ?')
      args.push(nextName)
    }
    if (contentChanged) {
      fields.push('content = ?')
      args.push(nextContent)
    }
    fields.push('updated_at = ?', 'updated_by = ?')
    args.push(now(), actor(by), docId)
    db.prepare(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`).run(...args)
    const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)
    saveDocumentVersion(updated, 'update')
    bumpRevision()
    return docVO(updated)
  }

  function upsertDocument(nodeId, name, content = null, by = 'user') {
    rawNode(nodeId)
    const docName = String(name || '').trim()
    if (!docName) throw new AppError(CODES.VALIDATION_FAILED, '文档名必填', { field: 'name' })
    const existing = db.prepare('SELECT * FROM documents WHERE node_id = ? AND name = ?').get(nodeId, docName)
    if (!existing) {
      const created = createDocument(nodeId, docName, content ?? '', by)
      return { id: created.id, created: true, name: docName }
    }
    if (content != null) updateDocument(existing.id, { content }, by)
    return { id: existing.id, created: false, name: docName }
  }

  function deleteDocument(docId) {
    const cur = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `文档 ${docId} 不存在`, { id: docId })
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    bumpRevision()
    return { id: docId }
  }

  function reorderDocuments(nodeId, orderedIds) {
    rawNode(nodeId)
    const ts = now()
    const upd = db.prepare('UPDATE documents SET sort = ?, updated_at = ? WHERE id = ? AND node_id = ?')
    db.exec('BEGIN')
    try {
      orderedIds.forEach((id, idx) => upd.run((idx + 1) * 10, ts, id, nodeId))
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    bumpRevision()
    return listDocuments(nodeId)
  }

  // ---------- commits（手工登记关联提交） ----------

  const SHA_RE = /^[0-9a-f]{7,40}$/i

  function commitVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      repo: r.repo,
      sha: r.sha,
      branch: r.branch,
      note: r.note,
      reviewStatus: r.review_status || 'pending',
      reviewNote: r.review_note,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      patchId: r.patch_id || null,
      createdAt: r.created_at
    }
  }

  /** 缓存 patch-id（重复检测用） */
  function setCommitPatchId(commitId, patchIdValue) {
    db.prepare('UPDATE commits SET patch_id = ? WHERE id = ?').run(patchIdValue, Number(commitId))
  }

  /** 全库提交（可限定 repo），带节点路径（用于跨节点重复关联） */
  function listCommitsWithNode({ repo = null } = {}) {
    const rows = repo
      ? db.prepare('SELECT * FROM commits WHERE repo = ? ORDER BY id').all(repo)
      : db.prepare('SELECT * FROM commits ORDER BY id').all()
    return rows.map((r) => ({ ...commitVO(r), nodePath: buildPath(r.node_id) }))
  }

  /** 沿 parent 链上溯，找第一个指定类型的祖先节点 */
  function findAncestorOfType(nodeId, type) {
    let cur = rawNode(nodeId)
    while (cur) {
      if (cur.type === type) return cur
      if (!cur.parent_id) return null
      cur = db.prepare('SELECT * FROM nodes WHERE id = ?').get(cur.parent_id)
    }
    return null
  }

  /**
   * 一键去重：删除重复登记（保留 keepId）。
   * 安全校验：removeIds 必须与 keep 同 repo，且 sha 相同或（非 merge 的）patch_id 相同
   */
  function dedupeCommits({ keepId, removeIds } = {}, by = 'user') {
    const keep = getCommit(Number(keepId))
    const ids = (Array.isArray(removeIds) ? removeIds : []).map((n) => Number(n)).filter(Number.isFinite)
    if (ids.length === 0) throw new AppError(CODES.VALIDATION_FAILED, 'removeIds 不能为空', {})
    const removed = []
    for (const id of ids) {
      if (id === keep.id) continue
      const c = getCommit(id)
      if (c.repo !== keep.repo) {
        throw new AppError(CODES.VALIDATION_FAILED, `提交 ${id} 与保留项仓库不同，不允许去重`, { id })
      }
      const sameSha = c.sha === keep.sha
      const samePatch = keep.patchId && c.patchId && keep.patchId !== '__merge__' && keep.patchId === c.patchId
      if (!sameSha && !samePatch) {
        throw new AppError(CODES.VALIDATION_FAILED, `提交 ${id} 与保留项不是重复关系（sha/patch-id 均不同），拒绝删除`, { id })
      }
      db.prepare('DELETE FROM commits WHERE id = ?').run(id)
      removed.push(id)
    }
    bumpRevision()
    return { kept: keep.id, removed }
  }

  function getCommit(id) {
    const r = db.prepare('SELECT * FROM commits WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `提交记录 ${id} 不存在`, { id })
    return commitVO(r)
  }

  function listCommits(nodeId, { subtree = false } = {}) {
    rawNode(nodeId)
    const ids = subtree ? subtreeIds(nodeId) : [nodeId]
    const ph = ids.map(() => '?').join(',')
    return db
      .prepare(`SELECT * FROM commits WHERE node_id IN (${ph}) ORDER BY created_at, id`)
      .all(...ids)
      .map(commitVO)
  }

  function addCommit(nodeId, { repo = null, sha, note = null, branch = null, overwriteBranch = false } = {}, by = 'user') {
    rawNode(nodeId)
    const s = String(sha || '').trim()
    if (!SHA_RE.test(s)) throw new AppError(CODES.VALIDATION_FAILED, 'sha 必须是 7–40 位十六进制', { sha: s })
    if (repo) {
      const known = db.prepare('SELECT id FROM repos WHERE name = ?').get(repo)
      if (!known) throw new AppError(CODES.REPO_NOT_REGISTERED, `仓库 ${repo} 未登记（先 repo add）`, { repo })
    }
    const existing = db.prepare('SELECT * FROM commits WHERE node_id = ? AND sha = ?').get(nodeId, s)
    if (existing) {
      // 已存在：补齐 branch（原来没有而这次给了）；overwriteBranch 时允许显式纠正已有值
      if (branch && (overwriteBranch ? branch !== existing.branch : !existing.branch)) {
        db.prepare('UPDATE commits SET branch = ? WHERE id = ?').run(branch, existing.id)
        bumpRevision()
        return { ...commitVO(db.prepare('SELECT * FROM commits WHERE id = ?').get(existing.id)), created: false }
      }
      return { ...commitVO(existing), created: false }
    }
    const ts = now()
    const info = db
      .prepare('INSERT INTO commits (node_id,repo,sha,branch,note,created_at) VALUES (?,?,?,?,?,?)')
      .run(nodeId, repo, s, branch, note, ts)
    bumpRevision()
    return { ...commitVO(db.prepare('SELECT * FROM commits WHERE id = ?').get(Number(info.lastInsertRowid))), created: true }
  }

  function removeCommit(commitId) {
    const cur = db.prepare('SELECT id FROM commits WHERE id = ?').get(commitId)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `提交记录 ${commitId} 不存在`, { id: commitId })
    db.prepare('DELETE FROM commits WHERE id = ?').run(commitId)
    bumpRevision()
    return { id: commitId }
  }

  // ---------- merges（显式合并尝试 / 冲突挂起 / 确认 / 放弃） ----------

  function parseConflictFiles(raw) {
    if (raw == null || raw === '') return []
    try {
      const value = JSON.parse(raw)
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }

  function mergeVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      repo: r.repo,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      baseSha: r.base_sha,
      sourceSha: r.source_sha,
      targetSha: r.target_sha,
      state: r.state,
      mergeSha: r.merge_sha,
      conflictFiles: parseConflictFiles(r.conflict_files),
      resolvedFiles: parseConflictFiles(r.resolved_files),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: r.created_by,
      updatedBy: r.updated_by
    }
  }

  function assertMergeState(state) {
    if (!MERGE_STATES.includes(state)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知合并状态 ${state}`, { state, allowed: MERGE_STATES })
    }
  }

  function getMerge(id) {
    const r = db.prepare('SELECT * FROM merges WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `合并记录 ${id} 不存在`, { id })
    return mergeVO(r)
  }

  function listMerges({ nodeId = null, state = null } = {}) {
    const clauses = []
    const args = []
    if (nodeId != null) {
      rawNode(nodeId)
      clauses.push('node_id = ?')
      args.push(Number(nodeId))
    }
    if (state != null) {
      assertMergeState(state)
      clauses.push('state = ?')
      args.push(state)
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    return db
      .prepare(`SELECT * FROM merges${where} ORDER BY created_at DESC, id DESC`)
      .all(...args)
      .map(mergeVO)
  }

  function addMerge(nodeId, {
    repo,
    sourceBranch,
    targetBranch,
    baseSha = null,
    sourceSha = null,
    targetSha = null,
    state = 'merged',
    mergeSha = null,
    conflictFiles = null
  } = {}, by = 'user') {
    rawNode(nodeId)
    if (!repo || !sourceBranch || !targetBranch) {
      throw new AppError(CODES.VALIDATION_FAILED, '合并记录需要 repo / sourceBranch / targetBranch', {
        repo,
        sourceBranch,
        targetBranch
      })
    }
    assertMergeState(state)
    const ts = now()
    const info = db
      .prepare(
        `INSERT INTO merges
         (node_id,repo,source_branch,target_branch,base_sha,source_sha,target_sha,state,merge_sha,conflict_files,created_at,updated_at,created_by,updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        nodeId,
        String(repo),
        String(sourceBranch),
        String(targetBranch),
        baseSha || null,
        sourceSha || null,
        targetSha || null,
        state,
        mergeSha || null,
        conflictFiles ? JSON.stringify(conflictFiles) : null,
        ts,
        ts,
        actor(by),
        actor(by)
      )
    bumpRevision()
    return mergeVO(db.prepare('SELECT * FROM merges WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function confirmMerge(id, { mergeSha = null } = {}, by = 'user') {
    const cur = db.prepare('SELECT * FROM merges WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `合并记录 ${id} 不存在`, { id })
    if (cur.state === 'aborted' || cur.state === 'merged') {
      throw new AppError(CODES.VALIDATION_FAILED, `状态为 ${cur.state} 的合并记录不能确认完成`, { id: cur.id, state: cur.state })
    }
    if (mergeSha && !SHA_RE.test(String(mergeSha))) {
      throw new AppError(CODES.VALIDATION_FAILED, 'mergeSha 必须是 7–40 位十六进制', { mergeSha })
    }
    // N4：不拿预检时的 target_sha 冒充「本地已应用后的提交」。未显式给 mergeSha
    // 就保持为空，避免审计字段指向合并前的旧目标 sha。
    const nextSha = mergeSha || cur.merge_sha || null
    db.prepare('UPDATE merges SET state = ?, merge_sha = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run('resolved', nextSha, now(), actor(by), cur.id)
    bumpRevision()
    return mergeVO(db.prepare('SELECT * FROM merges WHERE id = ?').get(cur.id))
  }

  /** 写回冲突处理产物：记录 resolved_files（path/content/sha/contentHash/source），不直接改分支 */
  function resolveMerge(id, { resolvedFiles = null } = {}, by = 'user') {
    const cur = db.prepare('SELECT * FROM merges WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `合并记录 ${id} 不存在`, { id })
    if (cur.state !== 'precheck_conflict') {
      throw new AppError(CODES.VALIDATION_FAILED, `只有 precheck_conflict 记录可写回冲突处理结果（当前 ${cur.state}）`, {
        id: cur.id,
        state: cur.state
      })
    }
    db.prepare('UPDATE merges SET resolved_files = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(resolvedFiles ? JSON.stringify(resolvedFiles) : null, now(), actor(by), cur.id)
    bumpRevision()
    return mergeVO(db.prepare('SELECT * FROM merges WHERE id = ?').get(cur.id))
  }

  function abortMerge(id, by = 'user') {
    const cur = db.prepare('SELECT * FROM merges WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `合并记录 ${id} 不存在`, { id })
    if (cur.state === 'merged') {
      throw new AppError(CODES.VALIDATION_FAILED, '已合并的记录不能放弃', { id: cur.id, state: cur.state })
    }
    db.prepare('UPDATE merges SET state = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run('aborted', now(), actor(by), cur.id)
    bumpRevision()
    return mergeVO(db.prepare('SELECT * FROM merges WHERE id = ?').get(cur.id))
  }

  /** 更新 commit 审查结果（pending / approved / issue）；pending 时清空审者信息 */
  function updateCommitReview(commitId, { reviewStatus, note = undefined } = {}, by = 'user') {
    if (!REVIEW_STATUSES.includes(reviewStatus)) {
      throw new AppError(CODES.VALIDATION_FAILED, `reviewStatus 必须是 ${REVIEW_STATUSES.join(' / ')}`, { reviewStatus })
    }
    const cur = db.prepare('SELECT * FROM commits WHERE id = ?').get(Number(commitId))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `提交记录 ${commitId} 不存在`, { id: commitId })
    const isPending = reviewStatus === 'pending'
    const reviewedBy = isPending ? null : by
    const reviewedAt = isPending ? null : now()
    if (note !== undefined) {
      db.prepare('UPDATE commits SET review_status=?, review_note=?, reviewed_by=?, reviewed_at=? WHERE id=?')
        .run(reviewStatus, note, reviewedBy, reviewedAt, cur.id)
    } else {
        db.prepare('UPDATE commits SET review_status=?, reviewed_by=?, reviewed_at=? WHERE id=?')
        .run(reviewStatus, reviewedBy, reviewedAt, cur.id)
    }
    bumpRevision()
    return commitVO(db.prepare('SELECT * FROM commits WHERE id = ?').get(cur.id))
  }

  // ---------- comments（diff 行级评论） ----------

  function commentVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      repo: r.repo,
      filePath: r.file_path,
      commitSha: r.commit_sha,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      snippet: r.snippet,
      content: r.content,
      author: r.author,
      status: r.status,
      createdAt: r.created_at
    }
  }

  function createComment(nodeId, { repo = null, filePath, commitSha = null, lineStart = 0, lineEnd = 0, snippet = null, content }, by = 'user') {
    rawNode(nodeId)
    if (!content || !content.trim()) {
      throw new AppError(CODES.VALIDATION_FAILED, '评论内容不能为空', {})
    }
    const info = db
      .prepare('INSERT INTO comments (node_id,repo,file_path,commit_sha,line_start,line_end,snippet,content,author,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(nodeId, repo, filePath || '', commitSha, Number(lineStart) || 0, Number(lineEnd) || 0, snippet, content.trim(), actor(by), 'open', now())
    bumpRevision()
    return commentVO(db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function listComments(nodeId, { filePath = null } = {}) {
    rawNode(nodeId)
    if (filePath) {
      return db.prepare('SELECT * FROM comments WHERE node_id = ? AND file_path = ? ORDER BY line_start, id')
        .all(nodeId, filePath)
        .map(commentVO)
    }
    return db.prepare('SELECT * FROM comments WHERE node_id = ? ORDER BY file_path, line_start, id')
      .all(nodeId)
      .map(commentVO)
  }

  /** 按文件（可选 commit）全库查——插件在 diff 里展示时用 */
  function listCommentsByFile(filePath, { commitSha = null } = {}) {
    if (commitSha) {
      return db.prepare('SELECT * FROM comments WHERE file_path = ? AND commit_sha = ? ORDER BY line_start, id')
        .all(filePath, commitSha)
        .map(commentVO)
    }
    return db.prepare('SELECT * FROM comments WHERE file_path = ? ORDER BY line_start, id')
      .all(filePath)
      .map(commentVO)
  }

  function updateComment(id, { status = null, content = null } = {}) {
    const r = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(id))
    if (!r) {
      throw new AppError(CODES.NOT_FOUND, `评论 ${id} 不存在`, { id })
    }
    db.prepare('UPDATE comments SET status = ?, content = ? WHERE id = ?')
      .run(status || r.status, content != null ? content : r.content, Number(id))
    bumpRevision()
    return commentVO(db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(id)))
  }

  function deleteComment(id) {
    db.prepare('DELETE FROM comments WHERE id = ?').run(Number(id))
    bumpRevision()
  }

  // ---------- 回归测试闭环（AI 可回归测试用例 + 测试/验收报告） ----------
  //
  // 需求 → 概要设计/文档（走 documents）→ AI 可回归测试（test_cases）→ 测试/验收报告（test_reports）。
  // kind 是统一扩展轴：v1 实现 regression / acceptance；code_check / biz_check / release_check
  // 已在 CHECK 里占位，新增一类检查只加用例，不改表结构与入口。

  const TEST_CASE_KINDS = new Set(['regression', 'acceptance', 'code_check', 'biz_check', 'release_check'])

  function testCaseVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      name: r.name,
      kind: r.kind,
      prompt: r.prompt,
      expectation: r.expectation,
      enabled: !!r.enabled,
      sort: r.sort,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: r.created_by,
      updatedBy: r.updated_by
    }
  }

  function assertCaseKind(kind) {
    if (!TEST_CASE_KINDS.has(kind)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知测试类型 ${kind}`, {
        kind,
        allowed: [...TEST_CASE_KINDS]
      })
    }
  }

  // 报告状态机（见 features/regression-loop/design.md §2「报告状态机」）：
  //   running → 终态（pass / fail / blocked / error / cancelled）单向；
  //   终态重复提交**同状态** = 幂等（允许补摘要/细节，不改 finished_at）；
  //   终态互转 / 终态 → running = 默认拒绝，需显式 overwrite:true 才覆盖。
  const TEST_REPORT_STATUSES = new Set(['running', 'pass', 'fail', 'blocked', 'error', 'cancelled'])
  const TERMINAL_REPORT_STATUSES = new Set(['pass', 'fail', 'blocked', 'error', 'cancelled'])

  function assertReportStatus(status) {
    if (!TEST_REPORT_STATUSES.has(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知报告状态 ${status}`, {
        status,
        allowed: [...TEST_REPORT_STATUSES]
      })
    }
  }

  /** 引用完整性：用例必须属于本节点，agent 任务必须存在 */
  function assertReportRefs(nodeId, { caseId, runId }) {
    if (caseId != null) {
      const c = db.prepare('SELECT id, node_id FROM test_cases WHERE id = ?').get(Number(caseId))
      if (!c) throw new AppError(CODES.NOT_FOUND, `测试用例 ${caseId} 不存在`, { caseId })
      if (c.node_id !== Number(nodeId)) {
        throw new AppError(CODES.VALIDATION_FAILED, `测试用例 ${caseId} 不属于节点 ${nodeId}`, {
          caseId: Number(caseId),
          nodeId: Number(nodeId),
          caseNodeId: c.node_id
        })
      }
    }
    if (runId != null && !db.prepare('SELECT id FROM agent_runs WHERE id = ?').get(Number(runId))) {
      throw new AppError(CODES.NOT_FOUND, `agent 任务 ${runId} 不存在`, { runId })
    }
  }

  function createTestCase(nodeId, { name, kind = 'regression', prompt, expectation = null, enabled = 1 }, by = 'user') {
    rawNode(nodeId)
    if (!name || !String(name).trim()) throw new AppError(CODES.VALIDATION_FAILED, '测试用例名必填', { field: 'name' })
    if (!prompt || !String(prompt).trim()) {
      throw new AppError(CODES.VALIDATION_FAILED, '测试用例内容（prompt）必填', { field: 'prompt' })
    }
    assertCaseKind(kind)
    const dup = db.prepare('SELECT id FROM test_cases WHERE node_id = ? AND name = ?').get(nodeId, String(name).trim())
    if (dup) {
      throw new AppError(CODES.TEST_CASE_NAME_EXISTS, `测试用例已存在：${String(name).trim()}`, { name: String(name).trim() })
    }
    const ts = now()
    const sort = db.prepare('SELECT IFNULL(MAX(sort),0) + 10 s FROM test_cases WHERE node_id = ?').get(nodeId).s
    const info = db
      .prepare(
        'INSERT INTO test_cases (node_id,name,kind,prompt,expectation,enabled,sort,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(nodeId, String(name).trim(), kind, String(prompt).trim(), expectation, enabled ? 1 : 0, sort, ts, ts, actor(by), actor(by))
    bumpRevision()
    return testCaseVO(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function listTestCases(nodeId, { kind = null, includeDisabled = false } = {}) {
    rawNode(nodeId)
    const rows = db.prepare('SELECT * FROM test_cases WHERE node_id = ? ORDER BY sort, id').all(nodeId)
    return rows
      .filter((r) => (kind ? r.kind === kind : true))
      .filter((r) => (includeDisabled ? true : !!r.enabled))
      .map(testCaseVO)
  }

  function getTestCase(id) {
    const r = db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `测试用例 ${id} 不存在`, { id })
    return testCaseVO(r)
  }

  /** 按用例名 get-or-create（幂等）：已存在则更新字段并返回 {created:false}，与文档 upsert 语义一致 */
  function upsertTestCase(nodeId, { name, kind = 'regression', prompt, expectation = null, enabled = 1 }, by = 'user') {
    rawNode(nodeId)
    const trimmed = name == null ? '' : String(name).trim()
    if (!trimmed) throw new AppError(CODES.VALIDATION_FAILED, '测试用例名必填', { field: 'name' })
    const cur = db.prepare('SELECT * FROM test_cases WHERE node_id = ? AND name = ?').get(nodeId, trimmed)
    if (!cur) return { ...createTestCase(nodeId, { name: trimmed, kind, prompt, expectation, enabled }, by), created: true }
    const updated = updateTestCase(cur.id, { kind, prompt, expectation, enabled }, by)
    return { ...updated, created: false }
  }

  function updateTestCase(id, { name = null, kind = null, prompt = null, expectation = undefined, enabled = null } = {}, by = 'user') {
    const cur = db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `测试用例 ${id} 不存在`, { id })
    if (kind != null) assertCaseKind(kind)
    if (name != null && !String(name).trim()) throw new AppError(CODES.VALIDATION_FAILED, '测试用例名不能为空', { field: 'name' })
    if (prompt != null && !String(prompt).trim()) throw new AppError(CODES.VALIDATION_FAILED, '测试用例内容不能为空', { field: 'prompt' })
    const nextName = name != null ? String(name).trim() : cur.name
    if (nextName !== cur.name) {
      const dup = db.prepare('SELECT id FROM test_cases WHERE node_id = ? AND name = ? AND id <> ?').get(cur.node_id, nextName, Number(id))
      if (dup) throw new AppError(CODES.TEST_CASE_NAME_EXISTS, `测试用例已存在：${nextName}`, { name: nextName })
    }
    db.prepare(
      'UPDATE test_cases SET name = ?, kind = ?, prompt = ?, expectation = ?, enabled = ?, updated_at = ?, updated_by = ? WHERE id = ?'
    ).run(
      nextName,
      kind || cur.kind,
      prompt != null ? String(prompt).trim() : cur.prompt,
      expectation !== undefined ? expectation : cur.expectation,
      enabled != null ? (enabled ? 1 : 0) : cur.enabled,
      now(),
      actor(by),
      Number(id)
    )
    bumpRevision()
    return testCaseVO(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(id)))
  }

  function deleteTestCase(id) {
    db.prepare('DELETE FROM test_cases WHERE id = ?').run(Number(id))
    bumpRevision()
  }

  function reorderTestCases(nodeId, orderedIds) {
    rawNode(nodeId)
    withoutBump(() => {
      orderedIds.forEach((id, i) => {
        db.prepare('UPDATE test_cases SET sort = ? WHERE id = ? AND node_id = ?').run((i + 1) * 10, Number(id), nodeId)
      })
    })
    bumpRevision()
    return listTestCases(nodeId, { includeDisabled: true })
  }

  function testReportVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      caseId: r.case_id,
      runId: r.run_id,
      kind: r.kind,
      status: r.status,
      summary: r.summary,
      detail: r.detail,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      updatedAt: r.updated_at,
      autoFinalized: !!r.auto_finalized,
      createdBy: r.created_by
    }
  }

  /** 开一条报告（一次执行 = 一行）；run_id 关联 agent 任务，便于从报告回看执行日志 */
  function createTestReport(nodeId, { caseId = null, runId = null, kind = 'regression', status = 'running', summary = null, detail = null }, by = 'user') {
    rawNode(nodeId)
    assertCaseKind(kind)
    assertReportStatus(status)
    assertReportRefs(nodeId, { caseId, runId })
    const ts = now()
    const info = db
      .prepare(
        'INSERT INTO test_reports (node_id,case_id,run_id,kind,status,summary,detail,started_at,finished_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(nodeId, caseId, runId, kind, status, summary, detail, ts, status === 'running' ? null : ts, ts, actor(by))
    bumpRevision()
    return testReportVO(db.prepare('SELECT * FROM test_reports WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function listTestReports(nodeId, { caseId = null, kind = null, limit = 100 } = {}) {
    rawNode(nodeId)
    return db
      .prepare('SELECT * FROM test_reports WHERE node_id = ? ORDER BY id DESC LIMIT ?')
      .all(nodeId, Number(limit) || 100)
      .filter((r) => (caseId ? r.case_id === Number(caseId) : true))
      .filter((r) => (kind ? r.kind === kind : true))
      .map(testReportVO)
  }

  function getTestReport(id) {
    const r = db.prepare('SELECT * FROM test_reports WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `测试报告 ${id} 不存在`, { id })
    return testReportVO(r)
  }

  /**
   * 回写报告状态（agent 任务结束 / 前台执行者回写时调用）。
   *
   * 状态机（与 features/regression-loop/design.md 一致）：
   *   - running → 终态：允许（单向推进）；
   *   - 终态 → 同状态：幂等（只更新摘要/细节，不改 finished_at）；
   *   - 终态 → 其它状态（含回退到 running）：默认拒绝 VALIDATION_FAILED，需显式 overwrite:true。
   */
  function finishTestReport(id, { status, summary = undefined, detail = undefined, runId = undefined, overwrite = false } = {}, by = 'user') {
    const cur = db.prepare('SELECT * FROM test_reports WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `测试报告 ${id} 不存在`, { id })
    if (status != null) assertReportStatus(status)
    if (runId !== undefined && runId !== null) {
      if (!db.prepare('SELECT id FROM agent_runs WHERE id = ?').get(Number(runId))) {
        throw new AppError(CODES.NOT_FOUND, `agent 任务 ${runId} 不存在`, { runId: Number(runId) })
      }
    }
    const nextStatus = status || cur.status
    const curTerminal = TERMINAL_REPORT_STATUSES.has(cur.status)
    // 人工可以自由改正「自动收尾」得出的结论（它只是机器兜底，不是人的判定）；
    // 只有人工/前台已确认过的终态才需要显式 overwrite 才能互转。
    const allowRefineAuto = !!cur.auto_finalized && !overwrite
    if (curTerminal && nextStatus !== cur.status && !overwrite && !allowRefineAuto) {
      throw new AppError(
        CODES.REPORT_STATUS_IMMUTABLE,
        `报告已处于终态 ${cur.status}，不能改为 ${nextStatus}（如需强制覆盖请显式 overwrite:true）`,
        { id: Number(id), current: cur.status, next: nextStatus }
      )
    }
    const ts = now()
    // 人工/前台一旦回写，这份结论就归人所有：清掉「自动收尾」标记，
    // 之后再改状态就回到常规的终态不可变规则（需显式 overwrite）。
    db.prepare(
      'UPDATE test_reports SET status = ?, summary = ?, detail = ?, run_id = ?, auto_finalized = ?, finished_at = ?, updated_at = ?, created_by = ? WHERE id = ?'
    ).run(
      nextStatus,
      summary !== undefined ? summary : cur.summary,
      detail !== undefined ? detail : cur.detail,
      runId !== undefined ? runId : cur.run_id,
      by === 'system' ? cur.auto_finalized : 0,
      // 终态重复提交同状态时保留原 finished_at（幂等）；首次进入终态才写入
      nextStatus === 'running' ? null : curTerminal ? cur.finished_at || ts : ts,
      ts,
      actor(by),
      Number(id)
    )
    bumpRevision()
    return testReportVO(db.prepare('SELECT * FROM test_reports WHERE id = ?').get(Number(id)))
  }

  /**
   * 由 agent 任务的终态自动收尾它关联的 running 报告。
   *
   * 背景：runTestCases / runReleaseChecks 派单后只负责开 running 报告；
   * 若派单方（尤其是 CLI 临时进程）在子进程结束前退出，报告会永远停在 running。
   * 这里在 run 落终态后立刻扫该 run 下仍 running 的报告并收尾，保证「派单即自动收尾」。
   *
   * 结论口径：优先从 agent 输出里解析 `用例名: PASS|FAIL|BLOCKED - 依据`（composeTestPrompt 的契约）；
   * 解析不到该用例的结论时，回落到 run 的整体终态（success→blocked，timeout/cancelled→cancelled，
   * failed→error）——宁可 blocked 也不报 pass，避免把「跑成功但没给结论」误判成通过。
   * 只收尾仍处于 running 的报告，不覆盖人工已回写的终态。
   */
  function finalizeReportsForRun(runId, { output = null, runStatus = null, by = 'system' } = {}) {
    const rid = Number(runId)
    if (!rid) return []
    const reports = db.prepare("SELECT * FROM test_reports WHERE run_id = ? AND status = 'running' ORDER BY id").all(rid)
    if (reports.length === 0) return []
    const run = db.prepare('SELECT status, output FROM agent_runs WHERE id = ?').get(rid)
    const status = runStatus || (run && run.status) || 'error'
    const text = output != null ? String(output) : (run && run.output) || ''
    const verdicts = parseRunVerdicts(text)
    // 结论回落：解析不到该用例的显式结论时，宁可 blocked 也不报 pass——否则会把「agent 成功但没给结论」伪造成绿灯。
    const fallback = status === 'cancelled' || status === 'timeout' ? 'cancelled' : status === 'success' ? 'blocked' : 'error'
    const fallbackNote = {
      blocked: 'agent 任务成功，但未在输出中解析到该用例的显式结论（未取得结论，不计入通过）',
      cancelled: `agent 任务${status === 'timeout' ? '超时' : '被取消'}，该用例未取得结论`,
      error: 'agent 任务失败，该用例未取得结论'
    }[fallback]
    const out = []
    withoutBump(() => {
      for (const r of reports) {
        const caseRow = r.case_id ? db.prepare('SELECT name FROM test_cases WHERE id = ?').get(r.case_id) : null
        const hit = caseRow ? verdicts.get(normalizeVerdictKey(caseRow.name)) : null
        const nextStatus = hit ? hit.status : fallback
        const summary = hit ? (hit.note || `${caseRow.name}: ${hit.status.toUpperCase()}`) : fallbackNote
        const detail = hit ? `由 agent run #${rid} 输出自动解析（${hit.raw}）` : `由 agent run #${rid} 终态（${status}）自动回写`
        const ts = now()
        db.prepare(
          'UPDATE test_reports SET status = ?, summary = ?, detail = ?, auto_finalized = 1, finished_at = ?, updated_at = ?, created_by = ? WHERE id = ?'
        ).run(nextStatus, summary, detail, ts, ts, actor(by), r.id)
        out.push(testReportVO(db.prepare('SELECT * FROM test_reports WHERE id = ?').get(r.id)))
      }
    })
    if (out.length > 0) bumpRevision()
    return out
  }

  /**
   * 验收报告聚合：把节点（含可选子树）下的用例与报告汇总成一个可读结构 ——
   * 每个用例的最近一次结果 + 总体通过率 + 未覆盖用例清单。
   *
   * 分桶口径（总数守恒，见 features/regression-loop/design.md §2「验收分桶」）：
   *   pass + fail + blocked + error + cancelled + running + notRun = cases
   * `running`（已派单未回写）与 `notRun`（从未派单）都不计入通过率分母；
   * 通过率 = pass / (pass + fail + blocked + error + cancelled)，即「已完结」口径。
   */
  function buildAcceptanceReport(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const ids = effectiveScope === 'subtree' ? subtreeIds(nodeId) : [nodeId]
    const ph = ids.map(() => '?').join(',')
    // 停用用例不参与门禁：与 readiness 的「启用中的可回归用例」口径一致。
    // 否则一条被停用的历史用例会永远以 not_run 阻塞交付，而 runTestCases 默认根本不会选它。
    const cases = db
      .prepare(`SELECT * FROM test_cases WHERE node_id IN (${ph}) AND enabled = 1 ORDER BY node_id, sort, id`)
      .all(...ids)
      .map(testCaseVO)
    const reports = db.prepare(`SELECT * FROM test_reports WHERE node_id IN (${ph}) ORDER BY id DESC`).all(...ids).map(testReportVO)
    const latestByCase = new Map()
    for (const r of reports) {
      if (r.caseId == null) continue
      if (!latestByCase.has(r.caseId)) latestByCase.set(r.caseId, r)
    }
    const items = cases.map((c) => {
      const latest = latestByCase.get(c.id) || null
      return {
        caseId: c.id,
        nodeId: c.nodeId,
        name: c.name,
        kind: c.kind,
        prompt: c.prompt,
        expectation: c.expectation,
        latestStatus: latest ? latest.status : 'not_run',
        latestReportId: latest ? latest.id : null,
        latestAt: latest ? latest.updatedAt : null
      }
    })
    const count = (s) => items.filter((i) => i.latestStatus === s).length
    const pass = count('pass')
    const fail = count('fail')
    const blocked = count('blocked')
    const error = count('error')
    const cancelled = count('cancelled')
    const running = count('running')
    const notRun = count('not_run')
    // 已完结（有终态结论）= 通过率分母；running / notRun 都不计
    const settled = pass + fail + blocked + error + cancelled
    const report = {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      totals: {
        cases: items.length,
        settled,
        pass,
        fail,
        blocked,
        error,
        cancelled,
        running,
        notRun
      },
      passRate: settled ? Math.round((pass / settled) * 1000) / 1000 : null,
      items,
      reports: reports.slice(0, 20)
    }
    // 证据指纹绑定“验收时实际签了什么”：按稳定 case id 构造 canonical 集合，
    // 纳入执行指令 prompt、期望、最近一次报告与结论；sort / latestAt 等展示或时间噪声不参与，
    // 否则仅 reorder 也会让签收失效。
    const canonicalCases = report.items
      .map((i) => ({
        caseId: i.caseId,
        nodeId: i.nodeId,
        name: i.name,
        kind: i.kind,
        prompt: i.prompt,
        expectation: i.expectation,
        latestStatus: i.latestStatus,
        latestReportId: i.latestReportId
      }))
      .sort((a, b) => a.caseId - b.caseId || a.nodeId - b.nodeId)
    const fingerprintInput = {
      scope: effectiveScope,
      totals: report.totals,
      passRate: report.passRate,
      cases: canonicalCases
    }
    report.evidenceFingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex')
    return report
  }

  // ---------- 验收签收（业务确认，与测试结论分离） ----------

  const ACCEPTANCE_DECISIONS = new Set(['accepted', 'rejected'])

  function acceptanceSignoffVO(r, currentFingerprint = null) {
    if (!r) return null
    return {
      id: r.id,
      nodeId: r.node_id,
      scope: r.scope,
      decision: r.decision,
      comment: r.comment,
      evidenceFingerprint: r.evidence_fingerprint,
      signedBy: r.signed_by,
      signedAt: r.signed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      stale: currentFingerprint != null && r.evidence_fingerprint !== currentFingerprint
    }
  }

  function assertAcceptanceDecision(decision) {
    if (!ACCEPTANCE_DECISIONS.has(decision)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知验收结论 ${decision}`, {
        decision,
        allowed: [...ACCEPTANCE_DECISIONS]
      })
    }
  }

  function getAcceptanceSignoff(nodeId, { scope = 'self' } = {}) {
    rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const row = db
      .prepare('SELECT * FROM acceptance_signoffs WHERE node_id = ? AND scope = ?')
      .get(nodeId, effectiveScope)
    return acceptanceSignoffVO(row)
  }

  function upsertAcceptanceSignoff(nodeId, { scope = 'self', decision, comment = null } = {}, by = 'user') {
    rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    assertAcceptanceDecision(decision)
    const report = buildAcceptanceReport(nodeId, { scope: effectiveScope })
    if (report.totals.cases === 0) {
      throw new AppError(CODES.VALIDATION_FAILED, '当前范围没有可验收的测试用例，不能签收', {
        nodeId,
        scope: effectiveScope
      })
    }
    const ts = now()
    const signer = actor(by)
    const cur = db
      .prepare('SELECT id FROM acceptance_signoffs WHERE node_id = ? AND scope = ?')
      .get(nodeId, effectiveScope)
    if (cur) {
      db.prepare(
        'UPDATE acceptance_signoffs SET decision = ?, comment = ?, evidence_fingerprint = ?, signed_by = ?, signed_at = ?, updated_at = ? WHERE id = ?'
      ).run(decision, comment, report.evidenceFingerprint, signer, ts, ts, cur.id)
    } else {
      db.prepare(
        'INSERT INTO acceptance_signoffs (node_id,scope,decision,comment,evidence_fingerprint,signed_by,signed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(nodeId, effectiveScope, decision, comment, report.evidenceFingerprint, signer, ts, ts, ts)
    }
    bumpRevision()
    return acceptanceSignoffVO(
      db.prepare('SELECT * FROM acceptance_signoffs WHERE node_id = ? AND scope = ?').get(nodeId, effectiveScope),
      report.evidenceFingerprint
    )
  }

  function buildAcceptanceStatus(nodeId, { scope = 'self' } = {}) {
    const report = buildAcceptanceReport(nodeId, { scope })
    const signoff = getAcceptanceSignoff(nodeId, { scope: report.scope })
    const signed = signoff ? { ...signoff, stale: signoff.evidenceFingerprint !== report.evidenceFingerprint } : null
    const state =
      !signoff
        ? report.totals.cases === 0
          ? 'not_applicable'
          : 'pending'
        : signed.stale
          ? 'stale'
          : signoff.decision
    return {
      node: report.node,
      scope: report.scope,
      state,
      accepted: state === 'accepted',
      report,
      signoff: signed
    }
  }

  // ---------- 需求就绪门禁（需求管理闭环的前置判定） ----------
  //
  // 闭环后半段已有结论：验收报告（测完没有）、上线清单（能不能上线）。
  // 这里补起点判定：一份需求进入回归测试前，需求内容 / 概要设计 / 可回归用例是否齐备。
  // 纯读聚合——不落表、不 bump revision（与 acceptance_report 同一条「结论不落库」原则）。

  const READINESS_UNIT_TYPES = new Set(['requirement', 'subreq'])

  function buildRequirementReadiness(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const ids = effectiveScope === 'subtree' ? subtreeIds(nodeId) : [nodeId]
    const unitRows = ids
      .map((id) => rawNode(id))
      .filter((r) => READINESS_UNIT_TYPES.has(r.type))
    if (unitRows.length === 0) {
      // 挂在项目 / 任务组上时 self 没有可判定单元；若子树里有，明确提示改用 subtree，
      // 否则调用方会误以为「这个节点压根没有需求」（与 runReleaseChecks 的 hintSubtree 同款）。
      // 只有「节点本身不是需求类型」才拒绝；子树里没有需求属于**空态**，
      // 按文档承诺返回 ready=null（不用 400 冒充空态，也不让 null 分支成为死代码）。
      if (effectiveScope === 'self' && !READINESS_UNIT_TYPES.has(root.type)) {
        const subtreeUnits = subtreeIds(nodeId)
          .map((id) => db.prepare('SELECT id,type FROM nodes WHERE id = ?').get(id))
          .filter((r) => r && READINESS_UNIT_TYPES.has(r.type))
        throw new AppError(
          CODES.VALIDATION_FAILED,
          subtreeUnits.length > 0
            ? `${root.type} 本身不是需求节点，但子树里有 ${subtreeUnits.length} 个需求——如需判定请用 scope=subtree`
            : `${root.type} 本身不是需求节点（门禁只判定 requirement / subreq）`,
          { nodeId: root.id, nodeType: root.type, subtreeUnits: subtreeUnits.length }
        )
      }
    }

    const requirementDocName = readiness.requirementDoc || DEFAULT_READINESS.requirementDoc
    const designDocName = readiness.designDoc || DEFAULT_READINESS.designDoc
    const caseKinds = new Set(
      Array.isArray(readiness.caseKinds) && readiness.caseKinds.length
        ? readiness.caseKinds
        : DEFAULT_READINESS.caseKinds
    )
    // 文档「存在」与「写完」是两回事：createNode 会预置**空白**需求内容文档，
    // 只判存在会让新建需求立刻“就绪”。口径必须是 同名文档 + 正文非空白。
    const docFilled = (docs, name) => {
      const hit = docs.find((d) => d.name === name)
      return !!hit && String(hit.content || '').trim() !== ''
    }

    const units = unitRows.map((row) => {
      const node = nodeVO(row)
      const docs = listDocuments(node.id)
      const cases = listTestCases(node.id, {})
      const regressable = cases.filter((c) => caseKinds.has(c.kind))
      const checks = [
        {
          key: 'requirement_doc',
          label: `需求内容文档「${requirementDocName}」`,
          passed: docFilled(docs, requirementDocName),
          detail: docFilled(docs, requirementDocName)
            ? `已填写（${docs.find((d) => d.name === requirementDocName).content.trim().length} 字）`
            : `缺少「${requirementDocName}」文档或正文为空`
        },
        {
          key: 'design_doc',
          label: `概要设计文档「${designDocName}」`,
          passed: docFilled(docs, designDocName),
          detail: docFilled(docs, designDocName)
            ? `已填写（${docs.find((d) => d.name === designDocName).content.trim().length} 字）`
            : `缺少「${designDocName}」文档或正文为空`
        },
        {
          key: 'regressable_cases',
          label: '可回归测试用例',
          passed: regressable.length > 0,
          detail:
            regressable.length > 0
              ? `已备 ${regressable.length} 条（${[...new Set(regressable.map((c) => c.kind))].join('/')}）`
              : `缺少启用中的 ${[...caseKinds].join(' / ')} 用例`
        }
      ]
      return {
        nodeId: node.id,
        name: node.name,
        type: node.type,
        path: node.path,
        ready: checks.every((c) => c.passed),
        checks
      }
    })

    const items = units.flatMap((u) =>
      u.checks.map((c) => ({
        nodeId: u.nodeId,
        name: u.name,
        type: u.type,
        key: c.key,
        label: c.label,
        passed: c.passed,
        detail: c.detail
      }))
    )
    const passed = items.filter((i) => i.passed).length
    const readyUnits = units.filter((u) => u.ready).length
    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      ready: units.length === 0 ? null : units.every((u) => u.ready),
      totals: {
        units: units.length,
        readyUnits,
        pendingUnits: units.length - readyUnits,
        checks: items.length,
        passed,
        failed: items.length - passed
      },
      units,
      items,
      blockers: items.filter((i) => !i.passed).map((i) => ({
        nodeId: i.nodeId,
        name: i.name,
        type: i.type,
        key: i.key,
        label: i.label,
        detail: i.detail
      }))
    }
  }

  // ---------- 思维导图（树 → mermaid mindmap 的只读投影） ----------
  //
  // 任务树本身是层级结构，天然适合用导图俯瞰「需求拆成了哪些子需求 / 任务组 / 子任务」。
  // 这里只把既有节点投影成 mermaid `mindmap` 文本，交给前端（Vditor 内置 mermaid 11.x）渲染，
  // 或由 AI 直接贴进 issue / 设计文档。**纯读**：不落表、不动 revision
  // （与 readiness / acceptance_report / delivery_gate 同一条「结论不落库」原则）。

  const MINDMAP_MAX_DEPTH_LIMIT = 50

  /**
   * mermaid mindmap 的节点标签用 `["文本"]` 承载。
   * 文本里出现双引号会提前闭合节点串（实测 `["a "b" c"]` 直接解析失败），
   * 因此统一走 HTML 实体转义：`"` → `&quot;`，`&` → `&amp;`（先做 & 避免二次转义）。
   * 其余字符（括号 / 方括号 / 花括号 / 竖线 / `#` / 冒号 / 中文 / 反斜杠 / 换行）在引号内实测 mermaid 均接受。
   */
  function escapeMindmapLabel(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
  }

  /**
   * 节点 → mermaid mindmap 行。
   * 缩进 = 深度 × 2 空格（mermaid 用缩进表达父子关系；顶层节点必须唯一）。
   * 标签为空时用占位符，避免 `[""]` 解析失败（实测空串会报错）。
   */
  function mindmapLine(name, depth) {
    const label = escapeMindmapLabel(name) || '（未命名）'
    return `${'  '.repeat(depth)}["${label}"]`
  }

  /**
   * 把节点树投影成 mermaid mindmap。
   *
   * - R1 挂任意节点；`scope=self` 只画本节点，`scope=subtree` 画本节点及其子树
   *   （与代码库其它聚合接口同一份 scope 口径；导图通常要 `subtree`，Web 页签默认即 subtree）。
   * - R2 节点用矩形 `["名"]`；层级由缩进表达（顶层唯一，mermaid 硬约束）。
   * - R3 标签做实体转义；空名用占位符；深度截断保护（`maxDepth`）。
   * - R4 只读：不写库、不动 revision。
   * - R5 输出含 `mermaid` 文本 + 结构化 `nodes`/`edges`/`totals`，前端/测试可分别校验。
   */
  function buildMindmap(nodeId, { scope = 'self', maxDepth = null } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    // `''`（如 HTTP `?maxDepth=`）算「显式给了非法值」：Number('') 会得 0，
    // 静默把导图截成只剩根节点比报错更难排查，与 scope 的「不静默降级」同一条纪律。
    const depthLimit =
      maxDepth === null || maxDepth === undefined
        ? Infinity
        : maxDepth === '' || Array.isArray(maxDepth)
          ? NaN
          : Number(maxDepth)
    if (depthLimit !== Infinity && (!Number.isInteger(depthLimit) || depthLimit < 0 || depthLimit > MINDMAP_MAX_DEPTH_LIMIT)) {
      throw new AppError(CODES.VALIDATION_FAILED, `maxDepth 需要是 0..${MINDMAP_MAX_DEPTH_LIMIT} 的整数`, {
        maxDepth,
        allowed: `0..${MINDMAP_MAX_DEPTH_LIMIT}`
      })
    }

    const rows = db.prepare('SELECT * FROM nodes ORDER BY sort, id').all()
    const byParent = new Map()
    for (const r of rows) {
      const key = r.parent_id == null ? null : r.parent_id
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key).push(r)
    }

    const mapNodes = []
    const edges = []
    // 子节点关系只用于渲染与遍历，不进入对外契约（对外用 edges 表达父子）
    const emittedChildren = new Map()
    const byId = new Map()
    let truncated = 0

    const build = (row, depth) => {
      const node = nodeVO(row)
      const entry = { id: node.id, name: node.name, type: node.type, status: node.status, depth }
      mapNodes.push(entry)
      byId.set(node.id, entry)
      const children = effectiveScope === 'subtree' ? byParent.get(row.id) || [] : []
      const childIds = []
      emittedChildren.set(node.id, childIds)
      if (depth >= depthLimit && children.length > 0) {
        truncated += children.length
        return entry
      }
      for (const child of children) {
        const childEntry = build(child, depth + 1)
        childIds.push(childEntry.id)
        edges.push({ from: node.id, to: childEntry.id })
      }
      return entry
    }

    build(root, 0)

    const lines = ['mindmap', mindmapLine(root.name, 0)]
    const walkLines = (id) => {
      for (const childId of emittedChildren.get(id) || []) {
        const child = byId.get(childId)
        lines.push(mindmapLine(child.name, child.depth))
        walkLines(childId)
      }
    }
    walkLines(root.id)

    const byType = {}
    for (const n of mapNodes) byType[n.type] = (byType[n.type] || 0) + 1

    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      mermaid: lines.join('\n') + '\n',
      nodes: mapNodes,
      edges,
      totals: {
        nodes: mapNodes.length,
        edges: edges.length,
        depth: mapNodes.reduce((m, n) => Math.max(m, n.depth), 0),
        byType,
        truncated
      }
    }
  }

  // ---------- 概要设计大纲 / 思维导图（需求管理 → 概要设计 → 文档 的生成侧） ----------
  //
  // 需求就绪门禁把「概要设计」文档作为进入回归测试的硬门禁之一，但此前只能靠人手工写。
  // 这里从既有需求树**推导**出概要设计骨架与 mermaid 思维导图：结构来自用户已经维护的
  // 子需求 / 任务组 / 子任务层级，因此不需要 AI 或人工再从零梳理一遍。
  // 纯读聚合——真正的落库由 ops.applyDesignOutline 走 upsertDocument，保持「读结论 / 写数据」分离。

  const OUTLINE_CHILD_TYPES = new Set(['requirement', 'subreq', 'group', 'task', 'defect'])

  /** 把某个需求节点下的结构收成一棵树（只保留子需求 / 任务组 / 子任务 / 缺陷） */
  function collectOutlineTree(rootRow) {
    const build = (row) => {
      const children = db
        .prepare('SELECT * FROM nodes WHERE parent_id = ? ORDER BY sort, id')
        .all(row.id)
        .filter((c) => OUTLINE_CHILD_TYPES.has(c.type))
        .map(build)
      return { id: row.id, name: row.name, type: row.type, status: row.status, children }
    }
    return build(rootRow)
  }

  function countOutlineNodes(tree) {
    return 1 + tree.children.reduce((sum, c) => sum + countOutlineNodes(c), 0)
  }

  /**
   * 概要设计大纲聚合：对 requirement / subreq（scope=self|subtree）推导
   * 结构树 + 节点计数，供 ops 渲染 markdown 骨架 / mermaid 思维导图。
   * 与需求就绪门禁同口径：非需求类型 self → 提示改用 subtree；子树无需求 → 空态。
   */
  function buildDesignOutline(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const ids = effectiveScope === 'subtree' ? subtreeIds(nodeId) : [nodeId]
    const unitRows = ids.map((id) => rawNode(id)).filter((r) => READINESS_UNIT_TYPES.has(r.type))
    if (unitRows.length === 0 && effectiveScope === 'self' && !READINESS_UNIT_TYPES.has(root.type)) {
      const subtreeUnits = subtreeIds(nodeId)
        .map((id) => db.prepare('SELECT id,type FROM nodes WHERE id = ?').get(id))
        .filter((r) => r && READINESS_UNIT_TYPES.has(r.type))
      throw new AppError(
        CODES.VALIDATION_FAILED,
        subtreeUnits.length > 0
          ? `${root.type} 本身不是需求节点，但子树里有 ${subtreeUnits.length} 个需求——如需推导概要设计请用 scope=subtree`
          : `${root.type} 本身不是需求节点（概要设计只针对 requirement / subreq）`,
        { nodeId: root.id, nodeType: root.type, subtreeUnits: subtreeUnits.length }
      )
    }

    const units = unitRows.map((row) => {
      const node = nodeVO(row)
      const tree = collectOutlineTree(row)
      return {
        nodeId: node.id,
        name: node.name,
        type: node.type,
        path: node.path,
        tree,
        nodeCount: countOutlineNodes(tree)
      }
    })

    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      totals: {
        units: units.length,
        nodes: units.reduce((sum, u) => sum + u.nodeCount, 0)
      },
      units
    }
  }

  // ---------- 上线治理（上线配置 / 上线 SQL / 上线检查清单） ----------
  //
  // 需求 → 概要设计/文档 → 回归测试（test_cases）→ 上线清单（release_items）。
  // kind = config / sql / check 对应「上线配置 / 上线 SQL / 上线检查」；
  // 代码检查 / 业务检查 / 上线检查的**执行**语义仍走 test_cases 的 code_check / biz_check / release_check，
  // 本表只做结构化登记（内容 + 回滚 + 状态 + 必做），保证三入口 1:1。

  const RELEASE_ITEM_KINDS = new Set(['config', 'sql', 'check'])
  const RELEASE_ITEM_STATUSES = new Set(['pending', 'ready', 'done', 'blocked', 'skipped'])

  function releaseItemVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      name: r.name,
      kind: r.kind,
      content: r.content,
      rollback: r.rollback,
      status: r.status,
      required: !!r.required,
      sort: r.sort,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: r.created_by,
      updatedBy: r.updated_by
    }
  }

  function assertReleaseKind(kind) {
    if (!RELEASE_ITEM_KINDS.has(kind)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知上线项类型 ${kind}`, { kind, allowed: [...RELEASE_ITEM_KINDS] })
    }
  }

  function assertReleaseStatus(status) {
    if (!RELEASE_ITEM_STATUSES.has(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知上线项状态 ${status}`, { status, allowed: [...RELEASE_ITEM_STATUSES] })
    }
  }

  function createReleaseItem(
    nodeId,
    { name, kind = 'config', content = '', rollback = null, status = 'pending', required = 1 },
    by = 'user'
  ) {
    rawNode(nodeId)
    if (!name || !String(name).trim()) {
      throw new AppError(CODES.VALIDATION_FAILED, '上线项名称必填', { field: 'name' })
    }
    assertReleaseKind(kind)
    assertReleaseStatus(status)
    const trimmed = String(name).trim()
    const dup = db.prepare('SELECT id FROM release_items WHERE node_id = ? AND name = ?').get(nodeId, trimmed)
    if (dup) {
      throw new AppError(CODES.RELEASE_ITEM_NAME_EXISTS, `上线项已存在：${trimmed}`, { name: trimmed })
    }
    const ts = now()
    const sort = db.prepare('SELECT IFNULL(MAX(sort),0) + 10 s FROM release_items WHERE node_id = ?').get(nodeId).s
    const info = db
      .prepare(
        'INSERT INTO release_items (node_id,name,kind,content,rollback,status,required,sort,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(nodeId, trimmed, kind, String(content ?? ''), rollback, status, required ? 1 : 0, sort, ts, ts, actor(by), actor(by))
    bumpRevision()
    return releaseItemVO(db.prepare('SELECT * FROM release_items WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function listReleaseItems(nodeId, { kind = null, status = null, includeOptional = true } = {}) {
    rawNode(nodeId)
    return db
      .prepare('SELECT * FROM release_items WHERE node_id = ? ORDER BY sort, id')
      .all(nodeId)
      .filter((r) => (kind ? r.kind === kind : true))
      .filter((r) => (status ? r.status === status : true))
      .filter((r) => (includeOptional ? true : !!r.required))
      .map(releaseItemVO)
  }

  function getReleaseItem(id) {
    const r = db.prepare('SELECT * FROM release_items WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `上线项 ${id} 不存在`, { id })
    return releaseItemVO(r)
  }

  /** 按名称 get-or-create（幂等）：已存在则更新字段并返回 {created:false}，与文档 / 用例 upsert 语义一致 */
  /**
   * 按名 get-or-create（幂等）。
   *
   * 覆盖 vs 保留：**新建**时未提供的字段用默认值（config / '' / null / pending / 必做）；
   * **已存在**时只更新显式传入的字段，其余保持原样——
   * 否则「只想改一句 content」的调用会把 rollback / status 静默清掉（独立测试第 6 节第 3 点）。
   * 需要显式清空某字段就传空值（如 `rollback: null` / `content: ''`）。
   */
  function upsertReleaseItem(nodeId, { name, kind, content, rollback, status, required } = {}, by = 'user') {
    rawNode(nodeId)
    const trimmed = name == null ? '' : String(name).trim()
    if (!trimmed) throw new AppError(CODES.VALIDATION_FAILED, '上线项名称必填', { field: 'name' })
    const cur = db.prepare('SELECT * FROM release_items WHERE node_id = ? AND name = ?').get(nodeId, trimmed)
    if (!cur) {
      return {
        ...createReleaseItem(
          nodeId,
          {
            name: trimmed,
            kind: kind ?? 'config',
            content: content ?? '',
            rollback: rollback ?? null,
            status: status ?? 'pending',
            required: required ?? 1
          },
          by
        ),
        created: true
      }
    }
    const updated = updateReleaseItem(
      cur.id,
      {
        kind: kind ?? null,
        content: content !== undefined ? content : undefined,
        rollback: rollback !== undefined ? rollback : undefined,
        status: status ?? null,
        required: required !== undefined ? required : null
      },
      by
    )
    return { ...updated, created: false }
  }

  function updateReleaseItem(
    id,
    { name = null, kind = null, content = undefined, rollback = undefined, status = null, required = null } = {},
    by = 'user'
  ) {
    const cur = db.prepare('SELECT * FROM release_items WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `上线项 ${id} 不存在`, { id })
    if (kind != null) assertReleaseKind(kind)
    if (status != null) assertReleaseStatus(status)
    if (name != null && !String(name).trim()) {
      throw new AppError(CODES.VALIDATION_FAILED, '上线项名称不能为空', { field: 'name' })
    }
    const nextName = name != null ? String(name).trim() : cur.name
    if (nextName !== cur.name) {
      const dup = db
        .prepare('SELECT id FROM release_items WHERE node_id = ? AND name = ? AND id <> ?')
        .get(cur.node_id, nextName, Number(id))
      if (dup) throw new AppError(CODES.RELEASE_ITEM_NAME_EXISTS, `上线项已存在：${nextName}`, { name: nextName })
    }
    db.prepare(
      'UPDATE release_items SET name = ?, kind = ?, content = ?, rollback = ?, status = ?, required = ?, updated_at = ?, updated_by = ? WHERE id = ?'
    ).run(
      nextName,
      kind || cur.kind,
      content !== undefined ? String(content ?? '') : cur.content,
      rollback !== undefined ? rollback : cur.rollback,
      status || cur.status,
      required != null ? (required ? 1 : 0) : cur.required,
      now(),
      actor(by),
      Number(id)
    )
    bumpRevision()
    return releaseItemVO(db.prepare('SELECT * FROM release_items WHERE id = ?').get(Number(id)))
  }

  function deleteReleaseItem(id) {
    const cur = db.prepare('SELECT id FROM release_items WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `上线项 ${id} 不存在`, { id })
    db.prepare('DELETE FROM release_items WHERE id = ?').run(Number(id))
    bumpRevision()
    return { id: Number(id) }
  }

  function reorderReleaseItems(nodeId, orderedIds) {
    rawNode(nodeId)
    withoutBump(() => {
      orderedIds.forEach((id, i) => {
        db.prepare('UPDATE release_items SET sort = ? WHERE id = ? AND node_id = ?').run((i + 1) * 10, Number(id), nodeId)
      })
    })
    bumpRevision()
    return listReleaseItems(nodeId)
  }

  /**
   * 上线检查（release readiness）：按节点（self / subtree）汇总上线清单的完成度。
   * 与验收报告同口径——只统计必做项（required）为阻塞项，可选项单列；空清单时 ready=null。
   */
  function buildReleaseChecklist(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const ids = effectiveScope === 'subtree' ? subtreeIds(nodeId) : [nodeId]
    const ph = ids.map(() => '?').join(',')
    const items = db
      .prepare(`SELECT * FROM release_items WHERE node_id IN (${ph}) ORDER BY node_id, sort, id`)
      .all(...ids)
      .map(releaseItemVO)
    const requiredItems = items.filter((i) => i.required)
    const optionalItems = items.filter((i) => !i.required)
    const pending = items.filter((i) => i.status === 'pending' || i.status === 'ready')
    const blocked = items.filter((i) => i.status === 'blocked')
    const pendingRequired = requiredItems.filter((i) => i.status !== 'done' && i.status !== 'skipped')
    const byKind = {}
    for (const i of items) byKind[i.kind] = (byKind[i.kind] || 0) + 1
    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      totals: {
        items: items.length,
        required: requiredItems.length,
        optional: optionalItems.length,
        done: items.filter((i) => i.status === 'done').length,
        // done 与 skipped 分开计数：两者都算「必做项不必再处理」，但含义不同——
        // 只报 done 会让「必做项都是 skipped」显示成「已完成：0」，看起来像没做完。
        skipped: items.filter((i) => i.status === 'skipped').length,
        blocked: blocked.length,
        pending: pending.length
      },
      byKind,
      ready: requiredItems.length === 0 ? null : pendingRequired.length === 0,
      blockers: pendingRequired.map((i) => ({
        id: i.id,
        nodeId: i.nodeId,
        name: i.name,
        kind: i.kind,
        status: i.status
      })),
      items
    }
  }

  // ---------- 交付门禁（汇总需求就绪 / 验收 / 上线三段结论） ----------
  //
  // 前三个功能各自回答一段问题：需求就绪门禁=能不能进测试，验收报告=测试过没过，
  // 上线清单=上线动作能不能执行。本聚合把它们收敛成调用方唯一需要消费的“能不能交付”结论。
  // 纯读、不落表、不 bump revision：结论必须随源数据实时变化，避免产生第二份真相。

  const DELIVERY_SOURCE_LABELS = {
    readiness: '需求就绪',
    acceptance: '测试验收',
    release: '上线治理'
  }

  function subtreeHasTypes(rootId, types) {
    return subtreeIds(rootId).some((id) => {
      const row = db.prepare('SELECT type FROM nodes WHERE id = ?').get(id)
      return row && types.has(row.type)
    })
  }

  function buildDeliveryGate(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const sources = []

    // 1. 需求就绪：self 只在需求两层上判定；子树模式只要子树中有需求两层就纳入。
    const readinessApplies =
      READINESS_UNIT_TYPES.has(root.type) || (effectiveScope === 'subtree' && subtreeHasTypes(root.id, READINESS_UNIT_TYPES))
    if (readinessApplies) {
      const readiness = buildRequirementReadiness(root.id, { scope: effectiveScope })
      sources.push({
        key: 'readiness',
        label: DELIVERY_SOURCE_LABELS.readiness,
        status: readiness.ready === true ? 'pass' : 'fail',
        applicable: true,
        detail:
          readiness.ready === true
            ? `${readiness.totals.readyUnits}/${readiness.totals.units} 个需求已就绪`
            : `${readiness.totals.pendingUnits} 个需求未就绪，${readiness.blockers.length} 项门禁阻塞`,
        evidence: readiness
      })
    } else {
      sources.push({
        key: 'readiness',
        label: DELIVERY_SOURCE_LABELS.readiness,
        status: 'not_applicable',
        applicable: false,
        detail: '当前范围没有 requirement / subreq 节点',
        evidence: null
      })
    }

    // 2. 测试验收：没有用例时是 not_applicable；有用例时还必须有当前证据对应的验收签收。
    const acceptanceStatus = buildAcceptanceStatus(root.id, { scope: effectiveScope })
    const acceptance = acceptanceStatus.report
    const at = acceptance.totals
    const acceptanceProblem = at.fail + at.blocked + at.error + at.cancelled + at.running + at.notRun
    const acceptanceApplicable = at.cases > 0
    const acceptancePassed = acceptanceProblem === 0 && acceptanceStatus.state === 'accepted'
    const acceptanceDetail =
      !acceptanceApplicable
        ? '暂无可回归测试用例'
        : acceptanceProblem > 0
          ? `${acceptanceProblem}/${at.cases} 条用例未通过或尚无终态结论`
          : acceptanceStatus.state === 'accepted'
            ? `${at.pass}/${at.cases} 条用例已通过，且验收签收有效`
            : acceptanceStatus.state === 'stale'
              ? '测试结论已变化，原验收签收已失效，需重新签收'
              : acceptanceStatus.state === 'rejected'
                ? '验收已驳回，需处理验收意见后重新签收'
                : '测试已通过，但尚未完成验收签收'
    sources.push({
      key: 'acceptance',
      label: DELIVERY_SOURCE_LABELS.acceptance,
      status: !acceptanceApplicable ? 'not_applicable' : acceptancePassed ? 'pass' : 'fail',
      applicable: acceptanceApplicable,
      detail: acceptanceDetail,
      evidence: { ...acceptance, signoff: acceptanceStatus.signoff, signoffState: acceptanceStatus.state }
    })

    // 3. 上线治理：无必做项不代表阻塞（not_applicable）；有任何必做项未 done/skipped 时不可交付。
    const release = buildReleaseChecklist(root.id, { scope: effectiveScope })
    sources.push({
      key: 'release',
      label: DELIVERY_SOURCE_LABELS.release,
      status: release.ready == null ? 'not_applicable' : release.ready ? 'pass' : 'fail',
      applicable: release.ready != null,
      detail:
        release.ready == null
          ? '当前范围没有必做上线项'
          : release.ready
            ? `${release.totals.required} 个必做上线项已完成或跳过`
            : `${release.blockers.length} 个必做上线项仍待处理或阻塞`,
      evidence: release
    })

    const blockers = []
    for (const source of sources) {
      if (source.status !== 'fail') continue
      if (source.key === 'readiness' && source.evidence) {
        for (const b of source.evidence.blockers) {
          blockers.push({ source: source.key, label: source.label, name: `${b.name} · ${b.label}`, detail: b.detail })
        }
      } else if (source.key === 'acceptance' && source.evidence) {
        const nonPass = source.evidence.items.filter((i) => i.latestStatus !== 'pass')
        for (const item of nonPass) {
          blockers.push({
            source: source.key,
            label: source.label,
            name: item.name,
            detail: `最近结果：${item.latestStatus}`
          })
        }
        if (nonPass.length === 0 && source.status === 'fail') {
          const state = source.evidence.signoffState
          blockers.push({
            source: source.key,
            label: source.label,
            name: source.evidence.node.name,
            detail:
              state === 'stale'
                ? '验收签收已失效（测试证据已变化）'
                : state === 'rejected'
                  ? '验收已驳回'
                  : '尚未完成验收签收'
          })
        }
      } else if (source.key === 'release' && source.evidence) {
        for (const b of source.evidence.blockers) {
          blockers.push({ source: source.key, label: source.label, name: b.name, detail: `上线项状态：${b.status}` })
        }
      }
    }

    const applicable = sources.filter((s) => s.applicable).length
    const passed = sources.filter((s) => s.status === 'pass').length
    const failed = sources.filter((s) => s.status === 'fail').length
    const decision = failed > 0 ? 'not_ready' : applicable > 0 ? 'ready' : 'unknown'
    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      decision,
      ready: decision === 'unknown' ? null : decision === 'ready',
      totals: {
        sources: sources.length,
        applicable,
        passed,
        failed,
        notApplicable: sources.length - applicable
      },
      sources,
      blockers
    }
  }

  // ---------- agent 运行时管理（参考 multica agent_runtime / chat_session / agent_task_queue） ----------
  //
  // 三层模型：
  //   agent_runtimes  —— 机器级执行环境（daemon_id + provider 唯一），带 online/offline 心跳；
  //   agent_sessions  —— 节点上一个 agent 的连续对话（可 --resume 续跑同一个 CLI 会话）；
  //   agent_runs      —— 一次任务（队列条目），带 attempt/parent_run_id 重试链 + 消息流。

  const TERMINAL_RUN_STATUSES = new Set(['success', 'failed', 'timeout', 'cancelled'])
  const AGENT_OUTPUT_LIMIT = 200 * 1024
  const AGENT_HEARTBEAT_STALE_MS = 90 * 1000

  function parseJson(raw, fallback = {}) {
    if (raw == null || raw === '') return fallback
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? v : fallback
    } catch {
      return fallback
    }
  }

  function safeParse(s) {
    try {
      return JSON.parse(s)
    } catch {
      return s
    }
  }

  function runtimeVO(r) {
    if (!r) return null
    return {
      id: r.id,
      name: r.name,
      daemonId: r.daemon_id,
      runtimeMode: r.runtime_mode,
      provider: r.provider,
      status: r.status,
      deviceInfo: r.device_info,
      visibility: r.visibility,
      metadata: parseJson(r.metadata, {}),
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: r.created_by
    }
  }

  function sessionVO(r) {
    if (!r) return null
    return {
      id: r.id,
      nodeId: r.node_id,
      agent: r.agent,
      runtimeId: r.runtime_id,
      title: r.title,
      cliSessionId: r.cli_session_id,
      workDir: r.work_dir,
      status: r.status,
      runCount: r.run_count,
      lastActivityAt: r.last_activity_at,
      createdAt: r.created_at,
      createdBy: r.created_by
    }
  }

  function agentRunVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      sessionId: r.session_id,
      runtimeId: r.runtime_id,
      agent: r.agent,
      model: r.model,
      prompt: r.prompt,
      cwd: r.cwd,
      status: r.status,
      output: r.output,
      exitCode: r.exit_code,
      attempt: r.attempt,
      maxAttempts: r.max_attempts,
      parentRunId: r.parent_run_id,
      failureReason: r.failure_reason,
      cliSessionId: r.cli_session_id,
      workDir: r.work_dir,
      priority: r.priority,
      resumed: !!r.resumed,
      waitReason: r.wait_reason,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      createdBy: r.created_by
    }
  }

  // ---------- 运行时 ----------

  /** 注册/更新运行时（按 daemon_id + provider 幂等 upsert；daemon 心跳也走这里） */
  function upsertRuntime({ name, daemonId, runtimeMode = 'local', provider = 'qodercli', status = 'online', deviceInfo = '', visibility = 'private', metadata = {} } = {}, by = 'system') {
    const d = String(daemonId || '').trim()
    const p = String(provider || '').trim()
    if (!d) throw new AppError(CODES.VALIDATION_FAILED, 'daemonId 不能为空', { field: 'daemonId' })
    if (!p) throw new AppError(CODES.VALIDATION_FAILED, 'provider 不能为空', { field: 'provider' })
    if (!['online', 'offline'].includes(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `status 非法：${status}`, { status })
    }
    const ts = now()
    const metaJson = JSON.stringify(metadata || {})
    const existing = db.prepare('SELECT * FROM agent_runtimes WHERE daemon_id = ? AND provider = ?').get(d, p)
    if (existing) {
      db.prepare(
        `UPDATE agent_runtimes SET name=?, runtime_mode=?, status=?, device_info=?, visibility=?, metadata=?,
           last_seen_at=CASE WHEN ?='online' THEN ? ELSE last_seen_at END, updated_at=? WHERE id=?`
      ).run(
        String(name || existing.name), runtimeMode, status, deviceInfo,
        visibility, metaJson, status, ts, ts, existing.id
      )
      bumpRevision()
      return runtimeVO(db.prepare('SELECT * FROM agent_runtimes WHERE id = ?').get(existing.id))
    }
    const info = db
      .prepare(
        `INSERT INTO agent_runtimes (name,daemon_id,runtime_mode,provider,status,device_info,visibility,metadata,last_seen_at,created_at,updated_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(String(name || p), d, runtimeMode, p, status, deviceInfo, visibility, metaJson, status === 'online' ? ts : null, ts, ts, actor(by))
    bumpRevision()
    return runtimeVO(db.prepare('SELECT * FROM agent_runtimes WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  /** 心跳：刷新 last_seen_at 并置 online。故意不 bumpRevision——心跳是高频噪声 */
  function heartbeatRuntime(id) {
    const r = db.prepare('SELECT * FROM agent_runtimes WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `运行时 ${id} 不存在`, { id })
    const ts = now()
    db.prepare("UPDATE agent_runtimes SET status='online', last_seen_at=?, updated_at=? WHERE id=?").run(ts, ts, Number(id))
    return runtimeVO(db.prepare('SELECT * FROM agent_runtimes WHERE id = ?').get(Number(id)))
  }

  function setRuntimeStatus(id, status) {
    if (!['online', 'offline'].includes(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `status 非法：${status}`, { status })
    }
    const r = db.prepare('SELECT * FROM agent_runtimes WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `运行时 ${id} 不存在`, { id })
    db.prepare('UPDATE agent_runtimes SET status=?, updated_at=? WHERE id=?').run(status, now(), Number(id))
    bumpRevision()
    return runtimeVO(db.prepare('SELECT * FROM agent_runtimes WHERE id = ?').get(Number(id)))
  }

  function getRuntime(id) {
    const r = db.prepare('SELECT * FROM agent_runtimes WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `运行时 ${id} 不存在`, { id })
    return runtimeVO(r)
  }

  /** 运行时列表：读时收敛——把超时未心跳的 online 行降级为 offline，不需要后台任务 */
  function listRuntimes({ status = null } = {}) {
    const stale = new Date(Date.now() - AGENT_HEARTBEAT_STALE_MS).toISOString()
    db.prepare("UPDATE agent_runtimes SET status='offline', updated_at=? WHERE status='online' AND (last_seen_at IS NULL OR last_seen_at < ?)")
      .run(now(), stale)
    const rows = status
      ? db.prepare('SELECT * FROM agent_runtimes WHERE status = ? ORDER BY id ASC').all(status)
      : db.prepare('SELECT * FROM agent_runtimes ORDER BY id ASC').all()
    return rows.map(runtimeVO)
  }

  function deleteRuntime(id) {
    const r = db.prepare('SELECT * FROM agent_runtimes WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `运行时 ${id} 不存在`, { id })
    const active = db.prepare('SELECT COUNT(*) c FROM agent_runs WHERE runtime_id = ? AND finished_at IS NULL').get(Number(id)).c
    if (active > 0) {
      throw new AppError(CODES.VALIDATION_FAILED, `运行时 ${id} 仍有 ${active} 个未完成任务，不能删除`, { active })
    }
    // 历史行解绑（不级联删除任务历史），再删运行时本身
    db.prepare('UPDATE agent_runs SET runtime_id = NULL WHERE runtime_id = ?').run(Number(id))
    db.prepare('UPDATE agent_sessions SET runtime_id = NULL WHERE runtime_id = ?').run(Number(id))
    db.prepare('DELETE FROM agent_runtimes WHERE id = ?').run(Number(id))
    bumpRevision()
    return { ok: true, id: Number(id) }
  }

  // ---------- 会话 ----------

  /** 取/建该 (node, agent) 的活动会话（幂等；续跑同一会话时用它） */
  function ensureAgentSession(nodeId, { agent = 'qodercli', runtimeId = null, workDir = null, title = '' } = {}, by = 'user') {
    rawNode(nodeId)
    const existing = db
      .prepare("SELECT * FROM agent_sessions WHERE node_id = ? AND agent = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
      .get(Number(nodeId), agent)
    if (existing) {
      if (runtimeId && existing.runtime_id !== Number(runtimeId)) {
        db.prepare('UPDATE agent_sessions SET runtime_id = ? WHERE id = ?').run(Number(runtimeId), existing.id)
      }
      if (workDir && existing.work_dir !== workDir) {
        db.prepare('UPDATE agent_sessions SET work_dir = ? WHERE id = ?').run(workDir, existing.id)
      }
      return sessionVO(db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(existing.id))
    }
    const info = db
      .prepare('INSERT INTO agent_sessions (node_id,agent,runtime_id,title,work_dir,status,run_count,last_activity_at,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(Number(nodeId), agent, runtimeId ? Number(runtimeId) : null, String(title || ''), workDir, 'active', 0, now(), now(), actor(by))
    bumpRevision()
    return sessionVO(db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  /** 显式新建会话（不复用旧会话；「新会话」按钮用） */
  function createAgentSession(nodeId, { agent = 'qodercli', runtimeId = null, workDir = null, title = '' } = {}, by = 'user') {
    rawNode(nodeId)
    const info = db
      .prepare('INSERT INTO agent_sessions (node_id,agent,runtime_id,title,work_dir,status,run_count,last_activity_at,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(Number(nodeId), agent, runtimeId ? Number(runtimeId) : null, String(title || ''), workDir, 'active', 0, now(), now(), actor(by))
    bumpRevision()
    return sessionVO(db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function getAgentSession(id) {
    const r = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `agent 会话 ${id} 不存在`, { id })
    return sessionVO(r)
  }

  function listAgentSessions(nodeId, { status = null, limit = 50 } = {}) {
    rawNode(nodeId)
    const rows = status
      ? db.prepare('SELECT * FROM agent_sessions WHERE node_id = ? AND status = ? ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT ?').all(Number(nodeId), status, Number(limit))
      : db.prepare('SELECT * FROM agent_sessions WHERE node_id = ? ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT ?').all(Number(nodeId), Number(limit))
    return rows.map(sessionVO)
  }

  function updateAgentSession(id, { title, status, cliSessionId, workDir } = {}) {
    const cur = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `agent 会话 ${id} 不存在`, { id })
    if (status && !['active', 'archived'].includes(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `status 非法：${status}`, { status })
    }
    db.prepare('UPDATE agent_sessions SET title=?, status=?, cli_session_id=?, work_dir=? WHERE id=?').run(
      title !== undefined ? String(title) : cur.title,
      status !== undefined ? status : cur.status,
      cliSessionId !== undefined ? cliSessionId : cur.cli_session_id,
      workDir !== undefined ? workDir : cur.work_dir,
      Number(id)
    )
    bumpRevision()
    return sessionVO(db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(Number(id)))
  }

  function archiveAgentSession(id) {
    return updateAgentSession(id, { status: 'archived' })
  }

  // ---------- 任务（run） ----------

  function touchSession(sessionId, ts) {
    if (!sessionId) return
    db.prepare('UPDATE agent_sessions SET run_count = run_count + 1, last_activity_at = ? WHERE id = ?').run(ts, Number(sessionId))
  }

  /**
   * 创建任务。sessionId 缺省时自动挂到该 (node, agent) 的活动会话（没有就建）；
   * parentRunId + attempt 构成重试链；resumed 表示这次是续跑同一个 CLI 会话。
   */
  function createAgentRun(
    nodeId,
    {
      agent = 'qodercli',
      model = 'DeepSeek-Flash',
      prompt,
      cwd = null,
      sessionId = null,
      runtimeId = null,
      attempt = 1,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
      parentRunId = null,
      priority = 0,
      resumed = false
    } = {},
    by = 'user'
  ) {
    rawNode(nodeId)
    const p = String(prompt || '').trim()
    if (!p) throw new AppError(CODES.VALIDATION_FAILED, 'prompt 不能为空', { field: 'prompt' })
    const maxA = Number(maxAttempts)
    if (!Number.isInteger(maxA) || maxA < 1) {
      throw new AppError(CODES.VALIDATION_FAILED, `maxAttempts 必须是 ≥1 的整数，收到：${maxAttempts}`, { maxAttempts })
    }
    const attemptA = Number(attempt)
    if (!Number.isInteger(attemptA) || attemptA < 1) {
      throw new AppError(CODES.VALIDATION_FAILED, `attempt 必须是 ≥1 的整数，收到：${attempt}`, { attempt })
    }
    const ts = now()
    let sid = sessionId ? Number(sessionId) : null
    if (sid) {
      const s = db.prepare('SELECT id FROM agent_sessions WHERE id = ?').get(sid)
      if (!s) throw new AppError(CODES.NOT_FOUND, `agent 会话 ${sid} 不存在`, { sessionId: sid })
    } else {
      sid = ensureAgentSession(nodeId, { agent, runtimeId, workDir: cwd }, by).id
    }
    const info = db
      .prepare(
        `INSERT INTO agent_runs (node_id,session_id,runtime_id,agent,model,prompt,cwd,status,attempt,max_attempts,parent_run_id,priority,resumed,started_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        Number(nodeId), sid, runtimeId ? Number(runtimeId) : null, agent, model, p, cwd,
        'running', attemptA, maxA,
        parentRunId ? Number(parentRunId) : null, Number(priority) || 0, resumed ? 1 : 0, ts, actor(by)
      )
    touchSession(sid, ts)
    bumpRevision()
    return agentRunVO(db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  /**
   * 追加执行输出（限 200KB）。
   * 大块 stdout 会按「无换行 + ≤4KB」切成多条 text 消息，落进消息流——
   * 这样 UI 可以按 seq 增量拉取，而不是每次整块重读 output 字段。
   */
  function appendAgentRunOutput(id, chunk) {
    const cur = db.prepare('SELECT output FROM agent_runs WHERE id = ?').get(Number(id))
    if (!cur) return
    const base = cur.output || ''
    if (base.length >= AGENT_OUTPUT_LIMIT) return
    const next = (base + chunk).slice(0, AGENT_OUTPUT_LIMIT)
    db.prepare('UPDATE agent_runs SET output = ? WHERE id = ?').run(next, Number(id))
  }

  /**
   * 追加一条任务消息（事件流；参考 multica task_message）。seq 服务端自增，保证顺序稳定。
   * 「读 MAX + 写」必须包在同一个写事务里，否则 MCP/CLI 等独立进程并发追加同一条任务时
   * 会各自读到同一个 MAX，撞 UNIQUE(run_id, seq)。BEGIN IMMEDIATE 让写事务一开始就持写锁，
   * 并在拿不到锁时按 busy_timeout + 重试兜底。
   */
  function appendAgentRunMessage(runId, { type, tool = null, content = null, input = null, output = null } = {}) {
    const rid = Number(runId)
    const run = db.prepare('SELECT id FROM agent_runs WHERE id = ?').get(rid)
    if (!run) throw new AppError(CODES.NOT_FOUND, `agent 任务 ${runId} 不存在`, { id: runId })
    const t = String(type || '').trim()
    if (!t) throw new AppError(CODES.VALIDATION_FAILED, '消息 type 不能为空', { field: 'type' })
    const ts = now()
    const inputVal = input == null ? null : (typeof input === 'string' ? input : JSON.stringify(input))
    const insertStmt = db.prepare(
      'INSERT INTO agent_run_messages (run_id,seq,type,tool,content,input,output,created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    const maxStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM agent_run_messages WHERE run_id = ?')
    const insertNext = () => {
      const seq = (maxStmt.get(rid).s || 0) + 1
      const info = insertStmt.run(rid, seq, t, tool, content, inputVal, output, ts)
      return { seq, id: Number(info.lastInsertRowid) }
    }

    let inserted
    if (db.isTransaction) {
      // 调用方已经开了事务，直接复用（此时写锁已在调用方事务里）
      inserted = insertNext()
    } else {
      let lastErr
      for (let i = 0; i <= SQLITE_BUSY_RETRIES; i++) {
        try {
          db.exec('BEGIN IMMEDIATE')
        } catch (e) {
          if (isSqliteBusy(e) && i < SQLITE_BUSY_RETRIES) {
            sleepSync(SQLITE_BUSY_RETRY_MS)
            continue
          }
          throw e
        }
        try {
          inserted = insertNext()
          db.exec('COMMIT')
          lastErr = null
          break
        } catch (e) {
          try {
            db.exec('ROLLBACK')
          } catch {
            /* 事务已结束则忽略 */
          }
          lastErr = e
          if (isSqliteBusy(e) && i < SQLITE_BUSY_RETRIES) {
            sleepSync(SQLITE_BUSY_RETRY_MS)
            continue
          }
          throw e
        }
      }
      if (lastErr) throw lastErr
      if (!inserted) throw new AppError(CODES.VALIDATION_FAILED, '消息写入失败', { id: runId })
    }

    const { seq, id } = inserted
    return {
      id,
      runId: rid,
      seq,
      type: t,
      tool,
      content,
      input: inputVal == null ? null : (typeof input === 'string' ? safeParse(inputVal) : input),
      output,
      createdAt: ts
    }
  }

  function listAgentRunMessages(runId, { sinceSeq = 0 } = {}) {
    const run = db.prepare('SELECT id FROM agent_runs WHERE id = ?').get(Number(runId))
    if (!run) throw new AppError(CODES.NOT_FOUND, `agent 任务 ${runId} 不存在`, { id: runId })
    return db
      .prepare('SELECT * FROM agent_run_messages WHERE run_id = ? AND seq > ? ORDER BY seq ASC')
      .all(Number(runId), Number(sinceSeq) || 0)
      .map((m) => ({
        id: m.id,
        runId: m.run_id,
        seq: m.seq,
        type: m.type,
        tool: m.tool,
        content: m.content,
        input: m.input == null ? null : safeParse(m.input),
        output: m.output,
        createdAt: m.created_at
      }))
  }

  /**
   * 收尾任务。cliSessionId/workDir 会沉淀到所属会话，供下次 --resume 续跑。
   * failureReason 用 multica 的分类口径（runtime_recovery / timeout / agent_error…）。
   */
  function finishAgentRun(id, { status, exitCode = null, failureReason = null, cliSessionId = null, workDir = null } = {}) {
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `status 非法：${status}`, { status })
    }
    const cur = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `agent 任务 ${id} 不存在`, { id })
    const ts = now()
    db.prepare(
      'UPDATE agent_runs SET status=?, exit_code=?, failure_reason=?, cli_session_id=?, work_dir=?, finished_at=? WHERE id=?'
    ).run(
      status, exitCode, failureReason,
      cliSessionId !== null ? cliSessionId : cur.cli_session_id,
      workDir !== null ? workDir : cur.work_dir,
      ts, Number(id)
    )
    // 会话级的「记忆」：把 CLI 会话号与工作目录沉淀到 session，供 --resume 续跑
    if (cur.session_id) {
      const s = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(cur.session_id)
      if (s) {
        db.prepare('UPDATE agent_sessions SET cli_session_id=?, work_dir=?, last_activity_at=? WHERE id=?').run(
          cliSessionId !== null ? cliSessionId : s.cli_session_id,
          workDir !== null ? workDir : s.work_dir,
          ts,
          cur.session_id
        )
      }
    }
    // 任务落终态后自动收尾它关联的 running 报告，保证「派单即自动收尾」
    // （CLI 临时进程退出后没人回写时，这是唯一的兜底）；
    // 用 withoutBump 包住，让「收尾任务 + 收尾报告」仍只算一次 revision 递增。
    withoutBump(() => finalizeReportsForRun(Number(id), { runStatus: status }))
    bumpRevision()
    return agentRunVO(db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(Number(id)))
  }

  /** 取消任务（把未结束任务置 cancelled；参考 multica 的 cancelled 语义） */
  function cancelAgentRun(id, { reason = 'manual' } = {}) {
    const cur = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `agent 任务 ${id} 不存在`, { id })
    if (TERMINAL_RUN_STATUSES.has(cur.status)) return agentRunVO(cur)
    db.prepare("UPDATE agent_runs SET status='cancelled', failure_reason=?, finished_at=? WHERE id=?").run(reason, now(), Number(id))
    withoutBump(() => finalizeReportsForRun(Number(id), { runStatus: 'cancelled' }))
    bumpRevision()
    return agentRunVO(db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(Number(id)))
  }

  /** 重试：新建一条 attempt+1 的子任务，回头指向原任务（参考 multica 的 parent_task_id） */
  function retryAgentRun(id, { by = 'user' } = {}) {
    const cur = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `agent 任务 ${id} 不存在`, { id })
    if (!TERMINAL_RUN_STATUSES.has(cur.status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `任务 ${id} 尚未结束（${cur.status}），不能重试`, { status: cur.status })
    }
    // max_attempts 是硬上限：已用满最后一次尝试后拒绝重试，避免无限重试链
    const attempt = Number(cur.attempt) || 1
    const maxAttempts = Number(cur.max_attempts) || 1
    if (attempt >= maxAttempts) {
      throw new AppError(
        CODES.VALIDATION_FAILED,
        `任务 ${id} 已达重试上限（第 ${attempt} 次 / 上限 ${maxAttempts} 次），不能再重试`,
        { attempt, maxAttempts }
      )
    }
    return createAgentRun(
      cur.node_id,
      {
        agent: cur.agent,
        model: cur.model,
        prompt: cur.prompt,
        cwd: cur.cwd,
        sessionId: cur.session_id,
        runtimeId: cur.runtime_id,
        attempt: attempt + 1,
        maxAttempts,
        parentRunId: cur.id,
        priority: cur.priority || 0,
        // 会话已有 CLI 会话号时，重试即续跑同一段对话
        resumed: !!cur.cli_session_id
      },
      by
    )
  }

  function getAgentRun(id) {
    const r = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(Number(id))
    if (!r) throw new AppError(CODES.NOT_FOUND, `agent 运行记录 ${id} 不存在`, { id })
    return agentRunVO(r)
  }

  function listAgentRuns(nodeId, { limit = 20, sessionId = null } = {}) {
    rawNode(nodeId)
    const rows = sessionId
      ? db.prepare('SELECT * FROM agent_runs WHERE node_id = ? AND session_id = ? ORDER BY id DESC LIMIT ?').all(Number(nodeId), Number(sessionId), Number(limit))
      : db.prepare('SELECT * FROM agent_runs WHERE node_id = ? ORDER BY id DESC LIMIT ?').all(Number(nodeId), Number(limit))
    return rows.map(agentRunVO)
  }

  /** 最近一次任务（用于「继续上次会话」） */
  function latestAgentRun(nodeId, { agent = null } = {}) {
    rawNode(nodeId)
    const row = agent
      ? db.prepare('SELECT * FROM agent_runs WHERE node_id = ? AND agent = ? ORDER BY id DESC LIMIT 1').get(Number(nodeId), agent)
      : db.prepare('SELECT * FROM agent_runs WHERE node_id = ? ORDER BY id DESC LIMIT 1').get(Number(nodeId))
    return row ? agentRunVO(row) : null
  }

  /** 运行时总览统计（运行时页卡片用） */
  function agentRuntimeSummary() {
    const runtimes = listRuntimes()
    const active = db.prepare('SELECT COUNT(*) c FROM agent_runs WHERE finished_at IS NULL').get().c
    const sessions = db.prepare("SELECT COUNT(*) c FROM agent_sessions WHERE status = 'active'").get().c
    return {
      runtimes: runtimes.length,
      online: runtimes.filter((r) => r.status === 'online').length,
      activeRuns: active,
      activeSessions: sessions
    }
  }

  /** 服务启动时调用：把残留的 running 标记为 failed（子进程已随服务退出） */
  function failStaleAgentRuns() {
    const ts = now()
    // 先记下将被中断的任务：它们关联的 running 报告也要一并收尾，否则重启后会永远停在 running
    const stalled = db.prepare("SELECT id FROM agent_runs WHERE status='running'").all().map((r) => r.id)
    const info = db
      .prepare("UPDATE agent_runs SET status='failed', failure_reason='runtime_recovery', output=COALESCE(output,'') || ?, finished_at=? WHERE status='running'")
      .run('\n[task-board] 服务重启，本次运行已中断\n', ts)
    // 重启后没有任何 daemon 在线：把在线行收敛为离线，等下次心跳恢复
    db.prepare("UPDATE agent_runtimes SET status='offline', updated_at=? WHERE status='online'").run(ts)
    if (info.changes > 0) {
      withoutBump(() => {
        for (const id of stalled) finalizeReportsForRun(id, { runStatus: 'failed' })
      })
      bumpRevision()
    }
    return { cleared: info.changes }
  }

  // ---------- 网页 → IDEA 打开请求（IDE 桥） ----------

  function ideRequestVO(r) {
    let payload = {}
    try {
      payload = JSON.parse(r.payload || '{}')
    } catch {
      payload = {}
    }
    return { id: r.id, kind: r.kind, status: r.status, ...payload, createdAt: r.created_at, handledAt: r.handled_at }
  }

  /** 网页端：请求 IDEA 打开 diff（cids 必填；commits 明细在此补全供插件直接使用） */
  function createIdeRequest(kind, payload, by = 'user') {
    if (kind !== 'open-diff') {
      throw new AppError(CODES.VALIDATION_FAILED, `不支持的 kind: ${kind}`, { kind })
    }
    const cids = ((payload && Array.isArray(payload.cids)) ? payload.cids : []).map((n) => Number(n)).filter(Number.isFinite)
    if (cids.length === 0) throw new AppError(CODES.VALIDATION_FAILED, 'cids 不能为空', {})
    const commits = cids.map((cid) => {
      const c = getCommit(cid)
      return { cid: c.id, sha: c.sha, repo: c.repo, note: c.note }
    })
    const body = JSON.stringify({
      cids,
      commits,
      path: (payload && payload.path) || null,
      title: (payload && payload.title) || null,
      requestedBy: actor(by)
    })
    const info = db
      .prepare('INSERT INTO ide_requests (kind,payload,status,created_at) VALUES (?,?,?,?)')
      .run(kind, body, 'pending', now())
    bumpRevision()
    return ideRequestVO(db.prepare('SELECT * FROM ide_requests WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  const IDE_REQUEST_TTL_MS = 10 * 60 * 1000
  const IDE_PROCESSING_TIMEOUT_MS = 30 * 1000

  /** IDEA 插件轮询领取：重置卡住的 processing + 过期清理 + 领最早的 pending 置为 processing */
  function claimNextIdeRequest() {
    const ts = now()
    db.prepare("UPDATE ide_requests SET status='pending' WHERE status='processing' AND handled_at < ?")
      .run(new Date(Date.now() - IDE_PROCESSING_TIMEOUT_MS).toISOString())
    db.prepare("UPDATE ide_requests SET status='expired', handled_at=? WHERE status IN ('pending','processing') AND created_at < ?")
      .run(ts, new Date(Date.now() - IDE_REQUEST_TTL_MS).toISOString())
    const row = db.prepare("SELECT * FROM ide_requests WHERE status='pending' ORDER BY id LIMIT 1").get()
    if (!row) return null
    db.prepare("UPDATE ide_requests SET status='processing', handled_at=? WHERE id=?").run(ts, row.id)
    return ideRequestVO({ ...row, status: 'processing' })
  }

  /** 插件处理完成回报（done / failed） */
  function completeIdeRequest(id, { status = 'done' } = {}) {
    if (!['done', 'failed'].includes(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `status 非法：${status}`, { status })
    }
    const cur = db.prepare('SELECT * FROM ide_requests WHERE id = ?').get(Number(id))
    if (!cur) throw new AppError(CODES.NOT_FOUND, `ide 请求 ${id} 不存在`, { id })
    db.prepare('UPDATE ide_requests SET status=?, handled_at=? WHERE id=?').run(status, now(), cur.id)
    return ideRequestVO(db.prepare('SELECT * FROM ide_requests WHERE id = ?').get(cur.id))
  }

  // ---------- repos（仓库登记） ----------

  function repoVO(r) {
    return {
      id: r.id,
      name: r.name,
      localPath: r.local_path,
      gitlabProject: r.gitlab_project,
      note: r.note,
      tags: r.tags,
      testBranch: r.test_branch,
      preBranch: r.pre_branch,
      releaseBranch: r.release_branch,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  function listRepos() {
    return db.prepare('SELECT * FROM repos ORDER BY name').all().map(repoVO)
  }

  function addRepo({ name, localPath = null, gitlabProject = null, note = null, tags = null, testBranch = null, preBranch = null, releaseBranch = null } = {}) {
    const n = String(name || '').trim()
    if (!n) throw new AppError(CODES.VALIDATION_FAILED, '仓库名必填', { field: 'name' })
    const dup = db.prepare('SELECT id FROM repos WHERE name = ?').get(n)
    if (dup) throw new AppError(CODES.VALIDATION_FAILED, `仓库 ${n} 已登记`, { name: n })
    const ts = now()
    const info = db
      .prepare('INSERT INTO repos (name,local_path,gitlab_project,note,tags,test_branch,pre_branch,release_branch,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(n, localPath, gitlabProject, note, tags, testBranch, preBranch, releaseBranch, ts, ts)
    bumpRevision()
    return repoVO(db.prepare('SELECT * FROM repos WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function updateRepo(id, patch) {
    const cur = db.prepare('SELECT * FROM repos WHERE id = ?').get(id)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `仓库 ${id} 不存在`, { id })
    const fields = []
    const args = []
    const map = { localPath: 'local_path', gitlabProject: 'gitlab_project', note: 'note', name: 'name', tags: 'tags', testBranch: 'test_branch', preBranch: 'pre_branch', releaseBranch: 'release_branch' }
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        fields.push(`${col} = ?`)
        args.push(patch[k])
      }
    }
    if (fields.length === 0) return repoVO(cur)
    fields.push('updated_at = ?')
    args.push(now(), id)
    db.prepare(`UPDATE repos SET ${fields.join(', ')} WHERE id = ?`).run(...args)
    bumpRevision()
    return repoVO(db.prepare('SELECT * FROM repos WHERE id = ?').get(id))
  }

  function deleteRepo(id) {
    const cur = db.prepare('SELECT id FROM repos WHERE id = ?').get(id)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `仓库 ${id} 不存在`, { id })
    db.prepare('DELETE FROM repos WHERE id = ?').run(id)
    bumpRevision()
    return { id }
  }

  // ---------- 工作单元仓库关联（unit_repos：node × repo）----------

  /** 工作单元 = 可拥有自己开发分支的节点；项目 / 需求 / 子需求不参与工作区分支 */
  const UNIT_TYPES = new Set(['group', 'task'])

  function assertUnitNode(nodeId) {
    const node = rawNode(nodeId)
    if (!UNIT_TYPES.has(node.type)) {
      throw new AppError(CODES.VALIDATION_FAILED, `只有任务组 / 子任务才能登记工作区仓库，当前为 ${node.type}`, {
        nodeId: node.id,
        type: node.type,
        allowed: [...UNIT_TYPES]
      })
    }
    return node
  }

  function unitRepoVO(r) {
    return {
      id: r.id,
      nodeId: r.node_id,
      repoId: r.repo_id,
      repoName: r.repo_name ?? null,
      branch: r.branch,
      worktreePath: r.worktree_path,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  const UNIT_REPO_SELECT = `
    SELECT ur.*, r.name AS repo_name
      FROM unit_repos ur LEFT JOIN repos r ON r.id = ur.repo_id`

  function listUnitRepos(nodeId) {
    rawNode(nodeId)
    return db.prepare(`${UNIT_REPO_SELECT} WHERE ur.node_id = ? ORDER BY ur.id`).all(nodeId).map(unitRepoVO)
  }

  function getUnitRepo(id) {
    const r = db.prepare(`${UNIT_REPO_SELECT} WHERE ur.id = ?`).get(id)
    if (!r) throw new AppError(CODES.NOT_FOUND, `工作单元仓库 ${id} 不存在`, { id })
    return unitRepoVO(r)
  }

  /**
   * 登记工作单元涉及仓库（按 node × repo 幂等 upsert）。
   * 已存在时只更新显式传入的字段——与 release item / test case 的 upsert 同一条
   * 「覆盖 vs 保留」纪律，避免只改一个字段把另一字段静默清空。
   */
  function addUnitRepo(nodeId, { repoId, branch = undefined, worktreePath = undefined } = {}, by = 'user') {
    assertUnitNode(nodeId)
    const rid = Number(repoId)
    if (!rid) throw new AppError(CODES.VALIDATION_FAILED, 'repoId 必填', { field: 'repoId' })
    const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(rid)
    if (!repo) throw new AppError(CODES.REPO_NOT_REGISTERED, `仓库 ${repoId} 未登记（先 repo add）`, { repoId: rid })

    const ts = now()
    const existing = db.prepare('SELECT * FROM unit_repos WHERE node_id = ? AND repo_id = ?').get(nodeId, rid)
    if (existing) {
      const patch = {}
      if (branch !== undefined) patch.branch = branch
      if (worktreePath !== undefined) patch.worktree_path = worktreePath
      if (Object.keys(patch).length === 0) return unitRepoVO(db.prepare(`${UNIT_REPO_SELECT} WHERE ur.id = ?`).get(existing.id))
      const fields = Object.keys(patch).map((k) => `${k} = ?`)
      db.prepare(`UPDATE unit_repos SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(patch), ts, existing.id)
      bumpRevision()
      return unitRepoVO(db.prepare(`${UNIT_REPO_SELECT} WHERE ur.id = ?`).get(existing.id))
    }

    const info = db
      .prepare('INSERT INTO unit_repos (node_id,repo_id,branch,worktree_path,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(nodeId, rid, branch ?? null, worktreePath ?? null, ts, ts)
    bumpRevision()
    return unitRepoVO(db.prepare(`${UNIT_REPO_SELECT} WHERE ur.id = ?`).get(Number(info.lastInsertRowid)))
  }

  function updateUnitRepo(id, patch = {}) {
    const cur = db.prepare('SELECT * FROM unit_repos WHERE id = ?').get(id)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `工作单元仓库 ${id} 不存在`, { id })
    const fields = []
    const args = []
    if (patch.branch !== undefined) {
      fields.push('branch = ?')
      args.push(patch.branch)
    }
    if (patch.worktreePath !== undefined) {
      fields.push('worktree_path = ?')
      args.push(patch.worktreePath)
    }
    if (fields.length === 0) return unitRepoVO(db.prepare(`${UNIT_REPO_SELECT} WHERE ur.id = ?`).get(id))
    fields.push('updated_at = ?')
    args.push(now(), id)
    db.prepare(`UPDATE unit_repos SET ${fields.join(', ')} WHERE id = ?`).run(...args)
    bumpRevision()
    return unitRepoVO(db.prepare(`${UNIT_REPO_SELECT} WHERE ur.id = ?`).get(id))
  }

  function deleteUnitRepo(id) {
    const cur = db.prepare('SELECT * FROM unit_repos WHERE id = ?').get(id)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `工作单元仓库 ${id} 不存在`, { id })
    db.prepare('DELETE FROM unit_repos WHERE id = ?').run(id)
    bumpRevision()
    return { id }
  }

  // ---------- 标签级分支配置（仓库通过 tags 继承） ----------

  function branchConfigVO(r) {
    return {
      id: r.id,
      tag: r.tag,
      testBranch: r.test_branch,
      preBranch: r.pre_branch,
      releaseBranch: r.release_branch,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  function listBranchConfigs() {
    return db.prepare('SELECT * FROM branch_configs ORDER BY tag').all().map(branchConfigVO)
  }

  function upsertBranchConfig(tag, { testBranch = null, preBranch = null, releaseBranch = null } = {}) {
    const t = String(tag || '').trim()
    if (!t) throw new AppError(CODES.VALIDATION_FAILED, '标签名必填', { field: 'tag' })
    const cur = db.prepare('SELECT * FROM branch_configs WHERE tag = ?').get(t)
    const ts = now()
    if (cur) {
      db.prepare('UPDATE branch_configs SET test_branch=?, pre_branch=?, release_branch=?, updated_at=? WHERE id=?')
        .run(testBranch, preBranch, releaseBranch, ts, cur.id)
      bumpRevision()
      return branchConfigVO(db.prepare('SELECT * FROM branch_configs WHERE id = ?').get(cur.id))
    }
    const info = db
      .prepare('INSERT INTO branch_configs (tag,test_branch,pre_branch,release_branch,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(t, testBranch, preBranch, releaseBranch, ts, ts)
    bumpRevision()
    return branchConfigVO(db.prepare('SELECT * FROM branch_configs WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function deleteBranchConfig(tag) {
    const t = String(tag || '').trim()
    const cur = db.prepare('SELECT * FROM branch_configs WHERE tag = ?').get(t)
    if (!cur) throw new AppError(CODES.NOT_FOUND, `标签配置 ${t} 不存在`, { tag: t })
    db.prepare('DELETE FROM branch_configs WHERE id = ?').run(cur.id)
    bumpRevision()
    return { id: cur.id }
  }

  /**
   * 解析仓库的追踪目标：仓库级（任一非空）优先；否则按 repo.tags 顺序取第一个有配置的标签
   * 返回 { test, pre, release, source }（source: 'repo' | 'tag:<名>' | null）
   */
  function resolveBranchTargets(repo) {
    const own = { test: repo.testBranch || null, pre: repo.preBranch || null, release: repo.releaseBranch || null }
    if (own.test || own.pre || own.release) return { ...own, source: 'repo' }
    const tags = String(repo.tags || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const tag of tags) {
      const cfg = db.prepare('SELECT * FROM branch_configs WHERE tag = ?').get(tag)
      if (cfg && (cfg.test_branch || cfg.pre_branch || cfg.release_branch)) {
        return { test: cfg.test_branch, pre: cfg.pre_branch, release: cfg.release_branch, source: `tag:${tag}` }
      }
    }
    return { test: null, pre: null, release: null, source: null }
  }

  return {
    db,
    // nodes
    createNode,
    updateNode,
    deleteNode,
    listRequirements,
    createRequirement,
    transitionRequirement,
    requirementSummary,
    REQUIREMENT_TRANSITIONS,
    getNode: (id) => nodeVO(rawNode(id)),
    resolveRef,
    listChildren,
    listTree,
    reorderSiblings,
    subtreeIds,
    // attrs / documents
    setAttrs,
    getAttrs,
    listAttrDefs,
    addAttrDef,
    updateAttrDef,
    deleteAttrDef,
    listDocuments,
    createDocument,
    updateDocument,
    upsertDocument,
    deleteDocument,
    reorderDocuments,
    listDocumentVersions,
    restoreDocumentVersion,
    docPresetNames,
    // commits
    getCommit,
    listCommits,
    addCommit,
    removeCommit,
    updateCommitReview,
    setCommitPatchId,
    listCommitsWithNode,
    findAncestorOfType,
    dedupeCommits,
    // merges（显式合并）
    getMerge,
    listMerges,
    addMerge,
    confirmMerge,
    resolveMerge,
    abortMerge,
    // comments（diff 行级评论）
    createComment,
    listComments,
    listCommentsByFile,
    updateComment,
    deleteComment,
    // 回归测试闭环（AI 可回归测试用例 + 测试/验收报告）
    TEST_CASE_KINDS,
    createTestCase,
    listTestCases,
    getTestCase,
    upsertTestCase,
    updateTestCase,
    deleteTestCase,
    reorderTestCases,
    createTestReport,
    listTestReports,
    getTestReport,
    finishTestReport,
    finalizeReportsForRun,
    buildAcceptanceReport,
    ACCEPTANCE_DECISIONS,
    getAcceptanceSignoff,
    upsertAcceptanceSignoff,
    buildAcceptanceStatus,
    // 需求就绪门禁（需求管理闭环的前置判定）
    SCOPE_VALUES,
    normalizeScope,
    FORMAT_VALUES,
    normalizeFormat,
    buildRequirementReadiness,
    // 概要设计大纲 / 思维导图（需求管理 → 概要设计 → 文档 的生成侧）
    buildDesignOutline,
    // 门禁口径（文档名 / 用例类型）——配置驱动，供概要设计骨架复用同一份「概要设计」文档名
    getReadinessConfig: () => ({ ...readiness }),
    // 思维导图（树 → mermaid mindmap 的只读投影）
    buildMindmap,
    // 上线治理（上线配置 / 上线 SQL / 上线检查清单）
    RELEASE_ITEM_KINDS,
    createReleaseItem,
    listReleaseItems,
    getReleaseItem,
    upsertReleaseItem,
    updateReleaseItem,
    deleteReleaseItem,
    reorderReleaseItems,
    buildReleaseChecklist,
    // 交付门禁（汇总需求就绪 / 验收 / 上线结论）
    buildDeliveryGate,
    // agent 运行时管理
    upsertRuntime,
    heartbeatRuntime,
    setRuntimeStatus,
    getRuntime,
    listRuntimes,
    deleteRuntime,
    agentRuntimeSummary,
    // agent 会话
    ensureAgentSession,
    createAgentSession,
    getAgentSession,
    listAgentSessions,
    updateAgentSession,
    archiveAgentSession,
    // agent 任务（runs）+ 消息流
    createAgentRun,
    appendAgentRunOutput,
    appendAgentRunMessage,
    listAgentRunMessages,
    finishAgentRun,
    cancelAgentRun,
    retryAgentRun,
    getAgentRun,
    listAgentRuns,
    latestAgentRun,
    failStaleAgentRuns,
    // IDE 桥（网页 → IDEA 打开 diff）
    createIdeRequest,
    claimNextIdeRequest,
    completeIdeRequest,
    // repos
    listRepos,
    addRepo,
    updateRepo,
    deleteRepo,
    // unit repos（工作单元 × 仓库：分支 + worktree）
    listUnitRepos,
    getUnitRepo,
    addUnitRepo,
    updateUnitRepo,
    deleteUnitRepo,
    // branch configs（标签级）
    listBranchConfigs,
    upsertBranchConfig,
    deleteBranchConfig,
    resolveBranchTargets,
    // revision
    getRevision,
    bumpRevision,
    // 组合写入：把一组内部写入合并成一次 revision 递增（工作区准备/清理需要）
    withoutBump
  }
}

import { createHash } from 'node:crypto'
import { AppError, CODES } from './errors.mjs'
import { CHILD_TYPES, LEAF_TYPES } from './db.mjs'

// actor 值域：写操作审计字段的允许值。'mcp' 与 'ai' 都表示「AI 经 MCP 写入」——
// 历史工具传 'ai'，部分工具传 'mcp'；'mcp' 此前不在值域内会被静默降级成 'user'，
// 让 AI 写的文档在审计上冒充「用户写的」。两个值都保留，避免历史审计语义被改写，
// 新工具统一用 'mcp'。'system' 用于平台自身的自动收尾（如 run 结算回写）。
// 非法值仍回退 'user'（见 actor()）。
const ACTORS = new Set(['user', 'ai', 'cli', 'import', 'mcp', 'system'])
const now = () => new Date().toISOString()
const REVIEW_STATUSES = ['pending', 'approved', 'issue']

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
const DOCUMENT_FILL_VALUES = ['filled', 'empty']

/**
 * 上线前置检查的**执行**复用 `test_cases` 的 kind 扩展轴：代码检查 / 业务检查 / 上线检查三类用例。
 * 上线清单聚合（`buildReleaseChecklist`）与派单编排（`runReleaseChecks`）共用这一份值域，
 * 避免「清单说就绪、派单却挑不到同一批用例」的口径漂移。
 */
export const RELEASE_CHECK_CASE_KINDS = new Set(['code_check', 'biz_check', 'release_check'])

/**
 * 上线 SQL 风险审查规则（与 config.releaseSqlAudit 默认值一致）。
 * `danger` 阻塞上线；`warn` 只提示。`requireNoWhere` 表示「语句内出现该模式且整条语句无 WHERE」才命中。
 */
const DEFAULT_RELEASE_SQL_AUDIT = {
  rules: [
    { key: 'drop_table', severity: 'danger', pattern: '\\bdrop\\s+(table|database)\\b', label: 'DROP TABLE / DROP DATABASE（不可逆）' },
    { key: 'truncate', severity: 'danger', pattern: '\\btruncate\\b', label: 'TRUNCATE（清空表数据）' },
    { key: 'delete_without_where', severity: 'danger', pattern: '\\bdelete\\s+from\\b', requireNoWhere: true, label: 'DELETE 缺少 WHERE 限定' },
    { key: 'update_without_where', severity: 'danger', pattern: '\\bupdate\\b', requireNoWhere: true, label: 'UPDATE 缺少 WHERE 限定' },
    { key: 'drop_column', severity: 'warn', pattern: '\\bdrop\\s+column\\b', label: 'DROP COLUMN（结构不可逆）' }
  ],
  requireRollback: true
}

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
  const transitionStatuses = Object.keys(REQUIREMENT_TRANSITIONS)
  const configuredRequirementStatuses = Array.isArray(options.status?.allowed?.requirement) && options.status.allowed.requirement.length
    ? [...new Set(options.status.allowed.requirement.map(String))]
    : DEFAULT_REQUIREMENT_STATUSES
  const unknownRequirementStatuses = configuredRequirementStatuses.filter((s) => !transitionStatuses.includes(s))
  if (unknownRequirementStatuses.length) {
    throw new AppError(
      CODES.VALIDATION_FAILED,
      `status.allowed.requirement 包含未定义流转规则的状态：${unknownRequirementStatuses.join(', ')}`,
      { invalid: unknownRequirementStatuses, allowed: transitionStatuses }
    )
  }
  if (!configuredRequirementStatuses.includes('todo')) {
    throw new AppError(CODES.VALIDATION_FAILED, 'status.allowed.requirement 必须包含起始状态 todo', {
      allowed: configuredRequirementStatuses,
      required: 'todo'
    })
  }
  const requirementStatuses = transitionStatuses.filter((s) => configuredRequirementStatuses.includes(s))
  const requirementStatusSet = new Set(requirementStatuses)
  const requirementTransitions = Object.fromEntries(
    requirementStatuses.map((s) => [s, (REQUIREMENT_TRANSITIONS[s] || []).filter((t) => requirementStatusSet.has(t))])
  )
  const deadEndStatuses = requirementStatuses.filter(
    (s) => s !== 'done' && (requirementTransitions[s] || []).length === 0
  )
  if (deadEndStatuses.length) {
    throw new AppError(
      CODES.VALIDATION_FAILED,
      `status.allowed.requirement 会产生无法继续流转的状态：${deadEndStatuses.join(', ')}`,
      { deadEnd: deadEndStatuses, transitions: requirementTransitions }
    )
  }
  const reachable = new Set(['todo'])
  const queue = ['todo']
  while (queue.length) {
    const cur = queue.shift()
    for (const next of requirementTransitions[cur] || []) {
      if (!reachable.has(next)) {
        reachable.add(next)
        queue.push(next)
      }
    }
  }
  if (!reachable.has('done')) {
    throw new AppError(CODES.VALIDATION_FAILED, 'status.allowed.requirement 必须保证 done 从 todo 可达', {
      reachable: [...reachable],
      transitions: requirementTransitions
    })
  }
  const releaseSqlAudit = options.releaseSqlAudit || DEFAULT_RELEASE_SQL_AUDIT
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
    return (requirementTransitions[from] || []).includes(to)
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
      canTransitionTo: requirementTransitions[node.status] || []
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
    if (!requirementStatusSet.has(status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知需求状态 ${status}`, {
        status,
        allowed: [...requirementStatusSet]
      })
    }
    if (!requirementStatusSet.has(cur.status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `需求当前状态 ${cur.status} 不在受控流转图内`, {
        status: cur.status,
        allowed: [...requirementStatusSet]
      })
    }
    if (cur.status === status) return requirementVO(cur)
    if (!canTransitionRequirement(cur.status, status)) {
      throw new AppError(CODES.VALIDATION_FAILED, `需求不能从 ${cur.status} 流转到 ${status}`, {
        from: cur.status,
        to: status,
        allowed: requirementTransitions[cur.status] || []
      })
    }
    updateNode(nodeId, { status }, by, { allowRequirementTransition: true })
    return requirementVO(rawNode(nodeId))
  }

  function requirementSummary({ projectId = null, status = null } = {}) {
    const items = listRequirements({ projectId, status })
    const byStatus = {}
    for (const key of requirementStatuses) byStatus[key] = 0
    let unknownStatusCount = 0
    let missingRequirementDoc = 0
    let missingDesignDoc = 0
    for (const item of items) {
      if (Object.prototype.hasOwnProperty.call(byStatus, item.status)) byStatus[item.status] += 1
      else unknownStatusCount += 1
      const [requirementDoc, designDoc] = requirementDocNames()
      if (!item.docState.find((d) => d.name === requirementDoc).filled) missingRequirementDoc += 1
      if (!item.docState.find((d) => d.name === designDoc).filled) missingDesignDoc += 1
    }
    return {
      total: items.length,
      byStatus,
      unknownStatusCount,
      missingRequirementDoc,
      missingDesignDoc
    }
  }

  function documentOverview({ projectId = null, status = null, q = null, docName = null, fill = null } = {}) {
    const fillValue = fill === null || fill === undefined || fill === '' ? null : String(fill)
    if (fillValue !== null && !DOCUMENT_FILL_VALUES.includes(fillValue)) {
      throw new AppError(CODES.VALIDATION_FAILED, `未知文档填充筛选 ${fill}`, {
        fill,
        allowed: DOCUMENT_FILL_VALUES
      })
    }
    const requirements = listRequirements({ projectId, status })
    const expectedNames = requirementDocNames()
    const query = q === null || q === undefined ? '' : String(q).trim().toLowerCase()
    const nameFilter = docName === null || docName === undefined ? '' : String(docName).trim()
    const allDocuments = []
    const gaps = []
    const matchesText = (...values) =>
      !query || values.some((v) => String(v || '').toLowerCase().includes(query))

    for (const req of requirements) {
      for (const doc of req.documents) {
        const content = String(doc.content || '')
        allDocuments.push({
          ...doc,
          contentPreview: content.replace(/\s+/g, ' ').trim().slice(0, 160),
          contentLength: content.trim().length,
          filled: content.trim() !== '',
          isRequired: expectedNames.includes(doc.name),
          nodeName: req.name,
          nodeType: req.type,
          nodeStatus: req.status,
          path: req.path,
          projectId: req.projectId,
          projectName: req.projectName
        })
      }
      for (const expected of expectedNames) {
        const doc = req.documents.find((d) => d.name === expected) || null
        if (doc && String(doc.content || '').trim() !== '') continue
        gaps.push({
          nodeId: req.id,
          nodeName: req.name,
          nodeType: req.type,
          nodeStatus: req.status,
          path: req.path,
          projectId: req.projectId,
          projectName: req.projectName,
          docName: expected,
          documentId: doc ? doc.id : null,
          linked: !!doc,
          filled: false,
          gapType: doc ? 'empty' : 'missing'
        })
      }
    }

    let items = allDocuments
    if (nameFilter) items = items.filter((d) => d.name === nameFilter)
    if (fillValue === 'filled') items = items.filter((d) => d.filled)
    if (fillValue === 'empty') items = items.filter((d) => !d.filled)
    if (query) items = items.filter((d) => matchesText(d.name, d.content, d.nodeName, d.path, d.projectName))

    let filteredGaps = gaps
    if (nameFilter) filteredGaps = filteredGaps.filter((g) => g.docName === nameFilter)
    if (fillValue === 'filled') filteredGaps = []
    if (query) filteredGaps = filteredGaps.filter((g) => matchesText(g.nodeName, g.path, g.projectName, g.docName))

    const linkedRequired = allDocuments.filter((d) => d.isRequired).length
    const filledRequired = allDocuments.filter((d) => d.isRequired && d.filled).length
    const requiredSlots = requirements.length * expectedNames.length

    return {
      scope: { projectId, status: status || null },
      expectedDocNames: expectedNames,
      summary: {
        requirementCount: requirements.length,
        documentCount: allDocuments.length,
        requiredSlotCount: requiredSlots,
        linkedRequiredSlotCount: linkedRequired,
        filledRequiredSlotCount: filledRequired,
        emptyRequiredSlotCount: linkedRequired - filledRequired,
        unlinkedRequiredSlotCount: requiredSlots - linkedRequired,
        missingRequiredSlotCount: requiredSlots - filledRequired,
        gapRequirementCount: new Set(gaps.map((g) => g.nodeId)).size,
        filteredDocumentCount: items.length,
        filteredGapCount: filteredGaps.length
      },
      items,
      gaps: filteredGaps
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
        requirementStatusSet.has(patch.status) &&
        !canTransitionRequirement(cur.status, patch.status) &&
        requirementStatusSet.has(cur.status)
      ) {
        throw new AppError(CODES.VALIDATION_FAILED, `需求不能从 ${cur.status} 流转到 ${patch.status}`, {
          from: cur.status,
          to: patch.status,
          allowed: requirementTransitions[cur.status] || []
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

  /**
   * 引用完整性：用例必须属于本节点，agent 任务必须存在。
   * 返回用例行（含 kind），供「报告 kind 必须与用例 kind 一致」的一致性校验复用。
   */
  function assertReportRefs(nodeId, { caseId, runId }) {
    let caseRow = null
    if (caseId != null) {
      caseRow = db.prepare('SELECT id, node_id, kind FROM test_cases WHERE id = ?').get(Number(caseId))
      if (!caseRow) throw new AppError(CODES.NOT_FOUND, `测试用例 ${caseId} 不存在`, { caseId })
      if (caseRow.node_id !== Number(nodeId)) {
        throw new AppError(CODES.VALIDATION_FAILED, `测试用例 ${caseId} 不属于节点 ${nodeId}`, {
          caseId: Number(caseId),
          nodeId: Number(nodeId),
          caseNodeId: caseRow.node_id
        })
      }
    }
    if (runId != null && !db.prepare('SELECT id FROM agent_runs WHERE id = ?').get(Number(runId))) {
      throw new AppError(CODES.NOT_FOUND, `agent 任务 ${runId} 不存在`, { runId })
    }
    return { caseRow }
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
  function createTestReport(nodeId, { caseId = null, runId = null, kind = undefined, status = 'running', summary = null, detail = null }, by = 'user') {
    rawNode(nodeId)
    assertReportStatus(status)
    const { caseRow } = assertReportRefs(nodeId, { caseId, runId })
    // 报告的 kind 与所挂用例的 kind 是**同一个事实**，因此：
    //   1) 未显式传 kind 时直接沿用用例的 kind（不再默认 regression）——避免「少传一个字段
    //      就把 regression 结论挂到 biz_check 用例上」的假绿（独立验收发现的边界）；
    //   2) 显式传了 kind 时必须是同一值，否则拒绝——错配报告一律不入库；
    //   3) 没有 caseId（用例已删除 / 临时跑一次）时才回落到默认 regression。
    const effectiveKind = kind == null ? (caseRow ? caseRow.kind : 'regression') : kind
    assertCaseKind(effectiveKind)
    if (caseRow && caseRow.kind !== effectiveKind) {
      throw new AppError(
        CODES.VALIDATION_FAILED,
        `报告类型 ${effectiveKind} 与用例「${caseRow.id}」的类型 ${caseRow.kind} 不一致`,
        { caseId: Number(caseId), caseKind: caseRow.kind, reportKind: effectiveKind }
      )
    }
    const ts = now()
    const info = db
      .prepare(
        'INSERT INTO test_reports (node_id,case_id,run_id,kind,status,summary,detail,started_at,finished_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(nodeId, caseId, runId, effectiveKind, status, summary, detail, ts, status === 'running' ? null : ts, ts, actor(by))
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

  /**
   * 每个用例的「最近一条报告」。（一次执行 = 一行，`id` 倒序取第一条。）
   *
   * **只接受 `report.kind === case.kind` 的报告**：报告的 kind 是这份结论属于哪条用例的
   * 一致性凭据。若把 `regression` 报告算到 `biz_check` 用例上，业务检查门禁会拿到一个
   * 与业务无关的 pass 并判定「业务可验收」——独立验收实测的假绿。
   * 写入侧 `createTestReport` 已经拦住这种错配；这里再收窄一次读取口径，
   * 是为了让**已经存在**的不一致历史行不再被信任（老库不受写入侧校验保护）。
   * 用例被删除后报告 `case_id` 置空，本函数直接跳过，与既有「历史报告保留但不再参与聚合」一致。
   */
  function latestReportByCase(caseVOs, reports) {
    const kindByCase = new Map(caseVOs.map((c) => [c.id, c.kind]))
    const latest = new Map()
    for (const r of reports) {
      if (r.caseId == null) continue
      const caseKind = kindByCase.get(r.caseId)
      if (caseKind == null) continue
      if (r.kind !== caseKind) continue
      if (!latest.has(r.caseId)) latest.set(r.caseId, r)
    }
    return latest
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
    // 只认 kind 与用例一致的报告，避免跨 kind 的结论冒充本用例结论（见 latestReportByCase）
    const latestByCase = latestReportByCase(cases, reports)
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

  const OUTLINE_CHILD_TYPES = new Set(['requirement', 'subreq', 'group', 'task', 'defect'])

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
  // ---------- 文档敏感信息扫描（只读安全前置判定） ----------
  //
  // AI 编码代理会把 curl 示例、环境变量片段、联调凭据写进需求 / 设计 / 验收文档；
  // 这些文档随后常被贴进 issue / MR / 测试报告，明文凭据一旦进入评审链就会扩散。
  // 这里对既有 documents 做一次只读扫描：命中即给稳定规则名与脱敏证据，不落表、不动 revision。
  // 关键约束：扫描结果本身绝不能再回显原值——证据只保留脱敏值与已替换为 `[REDACTED]` 的上下文。

  const SECRET_SCAN_PLACEHOLDER =
    /(example|sample|placeholder|your[_-]?|changeme|change[_-]?me|redacted|dummy|fake|todo|xxxx|<[^>]+>)/i

  const SECRET_SCAN_RULES = [
    {
      key: 'private_key_block',
      label: '私钥块',
      severity: 'danger',
      pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
      advice: '删除私钥正文并改为引用密钥管理系统 / CI Secret'
    },
    {
      key: 'aws_access_key',
      label: 'AWS Access Key',
      severity: 'danger',
      pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
      advice: '立即轮换该访问密钥，并从文档中移除'
    },
    {
      key: 'github_token',
      label: 'GitHub Token',
      severity: 'danger',
      pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
      advice: '立即吊销该 token，改用仓库 Secret / 环境变量'
    },
    {
      key: 'slack_token',
      label: 'Slack Token',
      severity: 'danger',
      pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
      advice: '撤销该 token 并从文档中移除'
    },
    {
      key: 'jwt',
      label: 'JWT Token',
      severity: 'danger',
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      advice: '示例改用占位符；真实 token 需要吊销并轮换'
    },
    {
      key: 'bearer_token',
      label: 'Bearer Token',
      severity: 'warn',
      pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})\b/gi,
      advice: '文档里的 Bearer token 改为 `<token>` 占位符'
    },
    {
      key: 'generic_secret_assignment',
      label: '密钥赋值',
      severity: 'danger',
      // 只匹配「键 + 分隔符 + 值」的显式赋值；示例 / 占位值在下面统一过滤。
      pattern: /["']?\b(api[_-]?key|secret|token|password|passwd|pwd)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_./+=~-]{12,})["']?/gi,
      advice: '示例统一使用占位符，真实凭据放入本机 config / CI Secret'
    }
  ]

  function maskSecretValue(value) {
    const s = String(value == null ? '' : value)
    if (s.length <= 8) return '***'
    return `${s.slice(0, 4)}***${s.slice(-4)}`
  }

  /**
   * 同一行可能命中多个凭据。excerpt 不能只替换当前命中片段，
   * 否则 A 命中的证据会把 B 命中的原文一起带出来，形成二次泄露。
   *
   * 这里先把同一行的全部命中区间合并成互不重叠的脱敏区间，
   * 再为每条 finding 生成完整脱敏后的上下文；主命中保留自己的规则名，其余命中也一并替换。
   */
  function mergeHitRanges(hits) {
    const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end)
    const merged = []
    for (const hit of sorted) {
      const last = merged[merged.length - 1]
      if (!last || hit.start >= last.end) {
        merged.push({ start: hit.start, end: hit.end, hits: [hit] })
      } else {
        last.end = Math.max(last.end, hit.end)
        last.hits.push(hit)
      }
    }
    return merged
  }

  function redactLineWithHits(line, hits, primary) {
    const raw = String(line == null ? '' : line)
    let out = ''
    let cursor = 0
    for (const range of mergeHitRanges(hits)) {
      out += raw.slice(cursor, range.start)
      const marker =
        range.hits.find((h) => h === primary) ||
        range.hits.find((h) => h.start <= primary.start && h.end >= primary.end) ||
        range.hits[0]
      out += `[REDACTED:${marker.rule}]`
      cursor = range.end
    }
    out += raw.slice(cursor)
    return out.trim().slice(0, 240)
  }

  /**
   * 文档敏感信息扫描：节点（含可选子树）文档正文 → 稳定规则命中 + 脱敏证据。
   *
   * ready 三态与其它只读聚合一致：有 danger 命中 → false；扫描过且只有 warn / 无命中 → true；
   * 范围内没有任何文档 → null（没有可扫描对象，不是「安全通过」）。
   */
  function buildSecretScan(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const ids = effectiveScope === 'subtree' ? subtreeIds(nodeId) : [nodeId]
    const ph = ids.map(() => '?').join(',')
    const docs = db
      .prepare(`SELECT * FROM documents WHERE node_id IN (${ph}) ORDER BY node_id, sort, id`)
      .all(...ids)
      .filter((d) => String(d.content || '').trim() !== '')
    const nodesById = new Map(ids.map((id) => [id, nodeVO(rawNode(id))]))
    const findings = []

    for (const doc of docs) {
      const text = String(doc.content || '')
      if (!text) continue
      const node = nodesById.get(doc.node_id)
      const lines = text.split(/\r?\n/)
      for (const [lineIndex, line] of lines.entries()) {
        const lineHits = []
        for (const rule of SECRET_SCAN_RULES) {
          const re = new RegExp(rule.pattern.source, rule.pattern.flags)
          let m
          while ((m = re.exec(line)) !== null) {
            const rawMatch = m[0]
            // 公共文档里的 AWS / GitHub 官方示例值必须放过，否则扫描会长期噪声化。
            if (rule.key !== 'generic_secret_assignment' && SECRET_SCAN_PLACEHOLDER.test(rawMatch)) {
              if (re.lastIndex === m.index) re.lastIndex += 1
              continue
            }
            let secretValue = rawMatch
            let redacted = maskSecretValue(rawMatch)
            let start = m.index
            let end = m.index + rawMatch.length

            if (rule.key === 'generic_secret_assignment') {
              secretValue = m[2] || ''
              if (!secretValue || SECRET_SCAN_PLACEHOLDER.test(secretValue)) continue
              const valueOffset = rawMatch.lastIndexOf(secretValue)
              start = m.index + valueOffset
              end = start + secretValue.length
              redacted = maskSecretValue(secretValue)
            } else if (rule.key === 'bearer_token') {
              secretValue = m[1] || rawMatch
              const valueOffset = rawMatch.lastIndexOf(secretValue)
              start = m.index + Math.max(0, valueOffset)
              end = start + secretValue.length
              redacted = maskSecretValue(secretValue)
            }

            lineHits.push({
              rule: rule.key,
              label: rule.label,
              severity: rule.severity,
              advice: rule.advice,
              start,
              end,
              redacted,
              secretValue
            })
            if (re.lastIndex === m.index) re.lastIndex += 1
          }
        }
        lineHits.sort((a, b) => a.start - b.start || b.end - a.end)
        for (const hit of lineHits) {
          findings.push({
            nodeId: doc.node_id,
            nodeName: node ? node.name : '',
            nodePath: node ? node.path : '',
            docId: doc.id,
            docName: doc.name,
            rule: hit.rule,
            label: hit.label,
            severity: hit.severity,
            advice: hit.advice,
            line: lineIndex + 1,
            column: hit.start + 1,
            redacted: hit.redacted,
            excerpt: redactLineWithHits(line, lineHits, hit)
          })
        }
      }
    }

    const danger = findings.filter((f) => f.severity === 'danger')
    const warnings = findings.filter((f) => f.severity === 'warn')
    const byRule = {}
    for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1
    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      ready: findings.length === 0 ? (docs.length === 0 ? null : true) : danger.length === 0,
      totals: {
        documents: docs.length,
        scannedCharacters: docs.reduce((n, d) => n + String(d.content || '').length, 0),
        findings: findings.length,
        danger: danger.length,
        warnings: warnings.length
      },
      byRule,
      findings,
      blockers: danger,
      warnings
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
   *
   * 只读聚合，不写库、不 bump revision：结论随源数据实时变化。
   *
   * 检查执行结论（check cases）：上线治理把「代码检查 / 业务检查 / 上线检查」的**执行**放在
   * test_cases 的 code_check / biz_check / release_check 三类用例上（见 features/release-governance/design.md R1）。
   * 因此本清单必须把已登记的这三类用例纳入就绪判定——否则「必做上线项都 done」会得到 ready=true，
   * 而登记在册、从未执行或已失败的检查用例被静默忽略（假绿灯）。
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
    // 检查用例：与 runReleaseChecks 挑用例的口径一致——三类一起纳入（含子树）。
    // 只算启用中的用例：停用的检查既不会被派单，也不该阻塞上线（与 readiness 口径一致）。
    const checkCases = db
      .prepare(`SELECT * FROM test_cases WHERE node_id IN (${ph}) AND enabled = 1 ORDER BY node_id, sort, id`)
      .all(...ids)
      .map(testCaseVO)
      .filter((c) => RELEASE_CHECK_CASE_KINDS.has(c.kind))
    const reports = db
      .prepare(`SELECT * FROM test_reports WHERE node_id IN (${ph}) ORDER BY id DESC`)
      .all(...ids)
      .map(testReportVO)
    // 每个用例只取最近一次报告：一次执行 = 一行，最近那行代表当前结论。
    const latestByCase = new Map()
    for (const r of reports) {
      if (r.caseId == null) continue
      if (!latestByCase.has(r.caseId)) latestByCase.set(r.caseId, r)
    }
    const cases = checkCases.map((c) => {
      const latest = latestByCase.get(c.id) || null
      return {
        id: c.id,
        nodeId: c.nodeId,
        name: c.name,
        kind: c.kind,
        latestStatus: latest ? latest.status : 'not_run',
        latestReportId: latest ? latest.id : null
      }
    })
    // 判定口径与 acceptance / delivery-gate 同源：只有 pass 才算通过；
    // running（已派单未回写）与 not_run（从未执行）都不是可交付证据。
    const blockingCases = cases.filter((c) => c.latestStatus !== 'pass')
    const requiredItems = items.filter((i) => i.required)
    const optionalItems = items.filter((i) => !i.required)
    const pending = items.filter((i) => i.status === 'pending' || i.status === 'ready')
    const blocked = items.filter((i) => i.status === 'blocked')
    const pendingRequired = requiredItems.filter((i) => i.status !== 'done' && i.status !== 'skipped')
    const byKind = {}
    for (const i of items) byKind[i.kind] = (byKind[i.kind] || 0) + 1
    const byCaseKind = {}
    for (const c of cases) byCaseKind[c.kind] = (byCaseKind[c.kind] || 0) + 1
    // 就绪 = 必做上线项全部完成/跳过 **且** 所有检查用例最近结论为 pass。
    // 无必做项且无检查用例时是空态 ready=null（不用 false 冒充未就绪）。
    // 只要存在检查用例，就已有可判定对象，因此空态判定必须同时看两侧。
    const hasJudgement = requiredItems.length > 0 || cases.length > 0
    const caseReady = cases.length === 0 || blockingCases.length === 0
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
        pending: pending.length,
        // 检查用例分桶（最近一次结论）：与验收报告同口径，running / notRun 单列。
        checkCases: cases.length,
        checkPass: cases.filter((c) => c.latestStatus === 'pass').length,
        checkRunning: cases.filter((c) => c.latestStatus === 'running').length,
        checkNotRun: cases.filter((c) => c.latestStatus === 'not_run').length,
        checkBlocking: blockingCases.length
      },
      byKind,
      byCaseKind,
      ready: hasJudgement ? pendingRequired.length === 0 && caseReady : null,
      blockers: pendingRequired.map((i) => ({
        id: i.id,
        nodeId: i.nodeId,
        name: i.name,
        kind: i.kind,
        status: i.status
      })),
      // 检查用例阻塞项单列：让调用方直接从 caseBlockers 生成待办，不必再遍历 cases。
      caseBlockers: blockingCases.map((c) => ({
        id: c.id,
        nodeId: c.nodeId,
        name: c.name,
        kind: c.kind,
        latestStatus: c.latestStatus,
        latestReportId: c.latestReportId
      })),
      items,
      checkCases: cases
    }
  }

  // ---------- 上线 SQL 风险审查（上线检查的静态前置判定） ----------
  //
  // 上线治理能回答「上线项做完了没有」，但不回答 kind=sql 的内容本身有没有风险。
  // 这里把节点（含子树）下的 SQL 上线项正文做**静态规则扫描**，给出「有没有高危写法」的结论。
  // 与 acceptance_report / readiness / release_checklist 同一条「只读聚合」原则：
  // 纯读、不落表、不 bump revision——结论从已登记内容实时推导，避免第二份真相。

  /**
   * 单次词法扫描：把 SQL 切成语句，并同时产出「只剩代码区」的掩码文本。
   *
   * 为什么不能分别做三处全文正则（独立测试 D1/D2/D3 的根因）：注释剥离、`;` 分段、
   * `WHERE` 判定必须共享同一份词法状态，否则字符串字面量会互相污染——
   *   - `UPDATE t SET note = 'where';`  字面量里的 where 会替无条件 UPDATE 洗白；
   *   - `SELECT '--'; DROP TABLE t;`    字面量里的 `--` 会当行注释吞掉后续危险语句；
   *   - `UPDATE t SET note = ';' WHERE id = 1;` 字面量里的 `;` 会错误切断语句。
   *
   * 处理范围：单引号字符串、双引号 / 反引号标识符、双减号行注释、斜杠星号块注释，
   * 以及字符串内的反斜杠转义与成对引号转义（两个单引号 / 两个双引号 / 两个反引号）。
   * 字符串与注释区间在掩码里替换为空格（保留字符长度便于定位），因此后续的规则正则与
   * `WHERE` 判定只在**代码区**进行；注释本身视作空白，被注释隔开的关键字仍能被正确识别。
   */
  function scanSql(sql) {
    const text = String(sql ?? '')
    const masked = new Array(text.length).fill(' ')
    const spans = []
    let start = 0
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === '-' && text[i + 1] === '-') {
        // 行注释：吞到行尾（换行本身留作空白）
        i += 2
        while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1
        continue
      }
      if (ch === '/' && text[i + 1] === '*') {
        // 块注释：吞到配对的 */（未闭合则吞到结尾）
        i += 2
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
        i = Math.min(i + 2, text.length)
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch
        i += 1
        while (i < text.length) {
          if (text[i] === '\\') {
            i += 2
            continue
          }
          if (text[i] === quote) {
            if (text[i + 1] === quote) {
              i += 2
              continue
            }
            i += 1
            break
          }
          i += 1
        }
        continue
      }
      if (ch === ';') {
        spans.push({ start, end: i })
        i += 1
        start = i
        continue
      }
      masked[i] = ch
      i += 1
    }
    spans.push({ start, end: text.length })
    return spans
      .map(({ start: s, end: e }) => ({ raw: text.slice(s, e).trim(), code: masked.slice(s, e).join('') }))
      .filter((s) => s.raw.length > 0)
  }

  /**
   * 单条语句命中哪些规则。规则与 `WHERE` 判定只针对**代码区**（字符串 / 注释已掩成空格），
   * 因此不会被字面量里的文本左右（见 design R3）；`raw` 只用于回显给调用方。
   */
  function auditSqlStatement({ raw, code }, rules) {
    const lower = code.toLowerCase()
    const hasWhere = /\bwhere\b/.test(lower)
    const hits = []
    for (const rule of rules) {
      let re
      try {
        re = new RegExp(rule.pattern, 'i')
      } catch {
        continue
      }
      if (!re.test(lower)) continue
      if (rule.requireNoWhere && hasWhere) continue
      hits.push({
        key: rule.key,
        severity: rule.severity === 'warn' ? 'warn' : 'danger',
        label: rule.label || rule.key,
        statement: raw
      })
    }
    return hits
  }

  /**
   * 规则集契约：`releaseSqlAudit.rules` 缺省 / 未配置 → 用默认规则；
   * 其余输入（**含 `null`**）一律按「非数组」显式拒绝，而不是静默回退默认——
   * `undefined`（字段缺省）才是「未配置」；`null` 是显式写了空值，属于配置写错。
   * 空数组同样拒绝：否则「想放宽规则」和「配置写错」都表现为悄悄使用默认集，
   * 或（若改成默认放行）把审查变成橡皮图章。要放宽请保留至少一条规则。
   */
  function resolveSqlAuditRules() {
    const configured = releaseSqlAudit ? releaseSqlAudit.rules : undefined
    if (configured === undefined) return DEFAULT_RELEASE_SQL_AUDIT.rules
    if (configured === null) {
      throw new AppError(
        CODES.VALIDATION_FAILED,
        'releaseSqlAudit.rules 不能为 null——缺省（字段不写）才用默认规则集；显式 null 属于非法配置',
        { rules: null }
      )
    }
    if (!Array.isArray(configured)) {
      throw new AppError(CODES.VALIDATION_FAILED, 'releaseSqlAudit.rules 必须是数组', { rules: configured })
    }
    if (configured.length === 0) {
      throw new AppError(
        CODES.VALIDATION_FAILED,
        'releaseSqlAudit.rules 不能为空数组——空规则集会静默放行所有 SQL；如需放宽请保留至少一条规则',
        { rules: configured }
      )
    }
    return configured
  }

  /**
   * 上线 SQL 风险审查：按节点（self / subtree）扫 kind=sql 上线项，给出「能否继续」的确定结论。
   * 纯读聚合。danger 命中 → ready=false；仅 warn → ready=true；范围内无 SQL 项 → ready=null。
   */
  function buildReleaseSqlAudit(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const ids = effectiveScope === 'subtree' ? subtreeIds(nodeId) : [nodeId]
    const rules = resolveSqlAuditRules()
    const requireRollback = releaseSqlAudit.requireRollback !== false

    const sqlItems = ids.flatMap((id) => listReleaseItems(id, { kind: 'sql' }))

    const items = sqlItems.map((item) => {
      const hits = []
      for (const statement of scanSql(item.content)) {
        hits.push(...auditSqlStatement(statement, rules))
      }
      if (requireRollback && !String(item.rollback ?? '').trim()) {
        hits.push({ key: 'sql_no_rollback', severity: 'warn', label: '缺少回滚脚本', statement: '' })
      }
      const dangerHits = hits.filter((h) => h.severity === 'danger')
      const warnHits = hits.filter((h) => h.severity === 'warn')
      return {
        id: item.id,
        nodeId: item.nodeId,
        name: item.name,
        status: item.status,
        required: item.required,
        content: item.content,
        rollback: item.rollback,
        ok: dangerHits.length === 0,
        dangerCount: dangerHits.length,
        warnCount: warnHits.length,
        hits
      }
    })

    const dangerItems = items.filter((i) => i.dangerCount > 0)
    const warnItems = items.filter((i) => i.warnCount > 0)
    const riskCount = items.reduce((n, i) => n + i.dangerCount, 0)
    const warningCount = items.reduce((n, i) => n + i.warnCount, 0)

    const blockers = dangerItems.flatMap((i) =>
      i.hits
        .filter((h) => h.severity === 'danger')
        .map((h) => ({
          id: i.id,
          nodeId: i.nodeId,
          name: i.name,
          key: h.key,
          label: h.label,
          statement: h.statement
        }))
    )
    const warnings = warnItems.flatMap((i) =>
      i.hits
        .filter((h) => h.severity === 'warn')
        .map((h) => ({
          id: i.id,
          nodeId: i.nodeId,
          name: i.name,
          key: h.key,
          label: h.label,
          statement: h.statement
        }))
    )

    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      ready: items.length === 0 ? null : dangerItems.length === 0,
      totals: {
        sqlItems: items.length,
        danger: dangerItems.length,
        risky: riskCount,
        warned: warnItems.length,
        warnings: warningCount
      },
      items,
      blockers,
      warnings
    }
  }

  // ---------- 业务检查门禁（业务可验收性的只读判定） ----------
  //
  // 上线治理把「业务检查」的**执行**挂在 test_cases 的 `biz_check` 用例上（见
  // features/release-governance/design.md R1），但此前没有任何聚合回答「业务侧到底能不能验收」：
  // 验收报告按 kind 不分桶（业务检查混在回归里），上线清单只把 biz_check 当作上线证据之一。
  // 本门禁补上这条独立结论，只回答两件事：
  //   1) 范围内**未关闭的缺陷**（defect 且 status 不在 done/cancelled）有没有清干净；
  //   2) 范围内启用中的 `biz_check` 用例最近一次结论是否都是 `pass`。
  // 纯读聚合：不落表、不 bump revision——结论必须随源数据实时变化，避免第二份真相。

  /** 缺陷视为「已关闭」的状态：与 config.status.allowed.defect 的终态一致。 */
  const CLOSED_DEFECT_STATUSES = new Set(['done', 'cancelled'])

  function buildBusinessGate(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const ids = effectiveScope === 'subtree' ? subtreeIds(nodeId) : [nodeId]
    const ph = ids.map(() => '?').join(',')

    // 缺陷：只把「未闭合」的算阻塞，终态（done / cancelled）不再拦住业务验收。
    const defectRows = db
      .prepare(`SELECT * FROM nodes WHERE id IN (${ph}) AND type = 'defect' ORDER BY sort, id`)
      .all(...ids)
    const openDefects = defectRows.filter((r) => !CLOSED_DEFECT_STATUSES.has(r.status))

    // 业务检查用例：与 buildReleaseChecklist / runReleaseChecks 的 kind 口径一致，
    // 只算启用中的用例（停用的既不会被派单，也不该阻塞业务验收）。
    const checkCases = db
      .prepare(`SELECT * FROM test_cases WHERE node_id IN (${ph}) AND enabled = 1 ORDER BY node_id, sort, id`)
      .all(...ids)
      .map(testCaseVO)
      .filter((c) => c.kind === 'biz_check')

    // 每个用例只取最近一次报告（一次执行 = 一行），避免历史 pass 掩盖后来的 fail。
    const reports = db
      .prepare(`SELECT * FROM test_reports WHERE node_id IN (${ph}) ORDER BY id DESC`)
      .all(...ids)
      .map(testReportVO)
    // 只认 kind 与用例一致的报告：跨 kind 的 pass 不得把业务检查判成通过（见 latestReportByCase）
    const latestByCase = latestReportByCase(checkCases, reports)
    const cases = checkCases.map((c) => {
      const latest = latestByCase.get(c.id) || null
      return {
        id: c.id,
        nodeId: c.nodeId,
        name: c.name,
        expectation: c.expectation,
        latestStatus: latest ? latest.status : 'not_run',
        latestReportId: latest ? latest.id : null
      }
    })
    // 与 acceptance / delivery-gate 同源口径：只有 pass 才算通过；
    // running（已派单未回写）与 not_run（从未执行）都不是可交付证据。
    const blockingCases = cases.filter((c) => c.latestStatus !== 'pass')

    const blockers = [
      ...openDefects.map((r) => ({
        kind: 'open_defect',
        nodeId: r.id,
        name: r.name,
        status: r.status
      })),
      ...blockingCases.map((c) => ({
        kind: 'unpassed_case',
        nodeId: c.nodeId,
        name: c.name,
        latestStatus: c.latestStatus,
        latestReportId: c.latestReportId
      }))
    ]

    // 空态：范围内既没有缺陷、也没有启用中的 biz_check 用例 → 没有可判定对象。
    const hasJudgement = defectRows.length > 0 || cases.length > 0
    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      ready: hasJudgement ? blockers.length === 0 : null,
      totals: {
        defects: defectRows.length,
        openDefects: openDefects.length,
        closedDefects: defectRows.length - openDefects.length,
        cases: cases.length,
        pass: cases.filter((c) => c.latestStatus === 'pass').length,
        running: cases.filter((c) => c.latestStatus === 'running').length,
        notRun: cases.filter((c) => c.latestStatus === 'not_run').length,
        blockingCases: blockingCases.length
      },
      blockers,
      defects: defectRows.map((r) => ({
        id: r.id,
        nodeId: r.id,
        name: r.name,
        status: r.status,
        closed: CLOSED_DEFECT_STATUSES.has(r.status)
      })),
      cases
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
          ? '当前范围没有必做上线项也没有检查用例'
          : release.ready
            ? `${release.totals.required} 个必做上线项已完成或跳过${release.totals.checkCases ? `，${release.totals.checkPass}/${release.totals.checkCases} 条检查用例通过` : ''}`
            : [
                release.blockers.length ? `${release.blockers.length} 个必做上线项仍待处理或阻塞` : null,
                release.totals.checkBlocking ? `${release.totals.checkBlocking} 条检查用例未通过或未执行` : null
              ]
                .filter(Boolean)
                .join('，'),
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
        // 检查用例（code / biz / release_check）也是上线就绪的证据，未 pass 时必须一并阻塞。
        for (const c of source.evidence.caseBlockers || []) {
          blockers.push({
            source: source.key,
            label: source.label,
            name: c.name,
            detail: `检查用例（${c.kind}）最近结论：${c.latestStatus}`
          })
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

  // ---------- 交付证据快照（冻结门禁结论，供验收 / 上线审计） ----------
  //
  // 实时门禁回答「现在能不能交付」；快照回答「当时凭什么放行」。快照只在显式 capture 时写入，
  // 后续读取会重新构建当前门禁并比较 fingerprint，返回 current / drifted，而不是把旧结论冒充现状。

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`
    if (value && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
        .join(',')}}`
    }
    return JSON.stringify(value)
  }

  /**
   * 交付漂移只认“证据集合”，不认节点/条目的展示文本。
   * name / path / label 是可改名、可翻译的呈现字段；把它们纳入指纹会让改错别字也触发 drifted。
   * id / status / totals / checks / reports / content 等证据字段仍完整保留。
   */
  const DELIVERY_FINGERPRINT_NON_SEMANTIC_KEYS = new Set([
    'name',
    'path',
    'label',
    'createdAt',
    'updatedAt',
    'createdBy',
    'updatedBy'
  ])
  function deliveryEvidence(value) {
    if (Array.isArray(value)) return value.map((v) => deliveryEvidence(v))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, child] of Object.entries(value)) {
        if (DELIVERY_FINGERPRINT_NON_SEMANTIC_KEYS.has(key)) continue
        out[key] = deliveryEvidence(child)
      }
      return out
    }
    return value
  }

  function deliveryFingerprint(gate) {
    return createHash('sha256').update(stableJson(deliveryEvidence(gate))).digest('hex')
  }

  function deliverySnapshotVO(row) {
    const gate = safeParse(row.gate_json)
    let drift = null
    try {
      const currentGate = buildDeliveryGate(row.node_id, { scope: row.scope })
      const currentFingerprint = deliveryFingerprint(currentGate)
      drift = {
        status: currentFingerprint === row.fingerprint ? 'current' : 'drifted',
        currentFingerprint,
        currentDecision: currentGate.decision
      }
    } catch {
      // 节点被删除时快照会随 FK 级联删除；其它读取异常不把审计记录伪装成 current。
      drift = { status: 'unknown', currentFingerprint: null, currentDecision: null }
    }
    return {
      id: row.id,
      nodeId: row.node_id,
      scope: row.scope,
      decision: row.decision,
      ready: row.ready == null ? null : !!row.ready,
      fingerprint: row.fingerprint,
      note: row.note,
      createdAt: row.created_at,
      createdBy: row.created_by,
      gate,
      drift
    }
  }

  function captureDeliverySnapshot(nodeId, { scope = 'self', note = null } = {}, by = 'user') {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const gate = buildDeliveryGate(root.id, { scope: effectiveScope })
    const fingerprint = deliveryFingerprint(gate)
    const ts = now()
    const info = db
      .prepare(
        `INSERT INTO delivery_snapshots (node_id, scope, decision, ready, fingerprint, gate_json, note, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        root.id,
        effectiveScope,
        gate.decision,
        gate.ready == null ? null : gate.ready ? 1 : 0,
        fingerprint,
        JSON.stringify(gate),
        note == null ? null : String(note),
        ts,
        actor(by)
      )
    bumpRevision()
    return deliverySnapshotVO(db.prepare('SELECT * FROM delivery_snapshots WHERE id = ?').get(Number(info.lastInsertRowid)))
  }

  function listDeliverySnapshots(nodeId, { scope = null, limit = 50 } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = scope == null ? null : normalizeScope(scope)
    const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50
    const rows = effectiveScope
      ? db
          .prepare('SELECT * FROM delivery_snapshots WHERE node_id = ? AND scope = ? ORDER BY id DESC LIMIT ?')
          .all(root.id, effectiveScope, lim)
      : db
          .prepare('SELECT * FROM delivery_snapshots WHERE node_id = ? ORDER BY id DESC LIMIT ?')
          .all(root.id, lim)
    return rows.map(deliverySnapshotVO)
  }

  function getDeliverySnapshot(id) {
    const row = db.prepare('SELECT * FROM delivery_snapshots WHERE id = ?').get(Number(id))
    if (!row) throw new AppError(CODES.NOT_FOUND, `交付快照 ${id} 不存在`, { id })
    return deliverySnapshotVO(row)
  }

  const WORKFLOW_STAGES = [
    { key: 'requirement', label: '需求管理', group: 'mainline' },
    { key: 'design', label: '概要设计', group: 'mainline' },
    { key: 'documents', label: '文档管理', group: 'mainline' },
    { key: 'mindmap', label: '思维导图', group: 'mainline' },
    { key: 'regression', label: 'AI 可回归测试', group: 'mainline' },
    { key: 'test_report', label: '测试报告', group: 'mainline' },
    { key: 'acceptance', label: '验收报告', group: 'mainline' },
    { key: 'release_config', label: '上线配置', group: 'release' },
    { key: 'release_sql', label: '上线 SQL', group: 'release' },
    { key: 'release_check', label: '上线检查', group: 'release' },
    { key: 'code_check', label: '代码检查', group: 'release' },
    { key: 'biz_check', label: '业务检查', group: 'release' }
  ]

  const WORKFLOW_STATUS_WEIGHT = { fail: 4, pending: 3, pass: 2, empty: 1 }
  // 仅参与整体聚合的阶段：mindmap 是“这张图已渲染出来”的展示性事实，
  // 不能作为研发进展证据，否则空项目也会被它抬成 pass。
  const WORKFLOW_EVIDENCE_STAGES = new Set(WORKFLOW_STAGES.map((s) => s.key).filter((key) => key !== 'mindmap'))
  const workflowWorstStatus = (items) => {
    const statuses = items.map((i) => i.status || 'empty')
    return statuses.reduce(
      (worst, cur) => (WORKFLOW_STATUS_WEIGHT[cur] > WORKFLOW_STATUS_WEIGHT[worst] ? cur : worst),
      'empty'
    )
  }

  function workflowStageSummary(stageKey, unitItems) {
    const items = unitItems.filter((i) => i.stage === stageKey)
    const status = workflowWorstStatus(items)
    const counts = items.reduce(
      (acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1
        return acc
      },
      { pass: 0, fail: 0, pending: 0, empty: 0 }
    )
    return {
      status,
      detail:
        status === 'empty'
          ? '暂无数据'
          : `通过 ${counts.pass || 0} · 未通过 ${counts.fail || 0} · 待处理 ${counts.pending || 0} · 空 ${counts.empty || 0}`,
      counts
    }
  }

  /**
   * 检查类阶段按“逐用例最严重状态”收敛：
   * fail/blocked/error/cancelled → fail；running/not_run → pending；全部 pass 才 pass。
   * 不能用“最新一条报告”代表整个检查分支，否则一条 pass 会掩盖同 kind 下未执行的用例。
   */
  function workflowCheckStatus(checkCases) {
    if (!checkCases.length) return 'empty'
    let hasPending = false
    for (const item of checkCases) {
      const status = item.latestStatus || 'not_run'
      if (status === 'pass') continue
      if (status === 'running' || status === 'not_run') {
        hasPending = true
        continue
      }
      return 'fail'
    }
    return hasPending ? 'pending' : 'pass'
  }

  function workflowItem({ stage, unit, status, detail, meta = {} }) {
    const id = `branch:${stage}:${unit.id}`
    return {
      id,
      type: 'branch',
      stage,
      unitId: unit.id,
      label: unit.name,
      status,
      detail,
      meta
    }
  }

  function latestReportStatusForKind(nodeId, kind) {
    const reports = listTestReports(nodeId, { kind, limit: 100 })
    if (reports.length === 0) return null
    return reports[0].status
  }

  /** 每个检查用例的最近一次报告（前端按用例回写终态时使用）。 */
  function latestReportsByCase(nodeId, kind) {
    const reports = listTestReports(nodeId, { kind, limit: 300 })
    const byCase = new Map()
    for (const report of reports) {
      if (report.caseId == null || byCase.has(report.caseId)) continue
      byCase.set(report.caseId, report)
    }
    return byCase
  }

  function releaseItemsMeta(items) {
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      status: item.status,
      required: item.required,
      rollback: item.rollback
    }))
  }

  function checkCasesMeta(cases, reportByCase) {
    return cases.map((testCase) => {
      const latest = reportByCase.get(testCase.id) || null
      return {
        id: testCase.id,
        name: testCase.name,
        kind: testCase.kind,
        latestReportId: latest ? latest.id : null,
        latestStatus: latest ? latest.status : 'not_run'
      }
    })
  }

  function mapReportStatus(status) {
    if (!status) return 'empty'
    if (status === 'pass') return 'pass'
    if (status === 'running') return 'pending'
    return 'fail'
  }

  function mapReleaseItems(items) {
    if (items.length === 0) return { status: 'empty', detail: '暂无登记' }
    const requiredPending = items.filter((i) => i.required && i.status !== 'done' && i.status !== 'skipped')
    const blocked = items.filter((i) => i.status === 'blocked')
    const status = requiredPending.length > 0 || blocked.length > 0 ? 'fail' : 'pass'
    return {
      status,
      detail: `共 ${items.length} 项 · 必做 ${items.filter((i) => i.required).length} · 完成 ${items.filter((i) => i.status === 'done').length} · 跳过 ${items.filter((i) => i.status === 'skipped').length} · 阻塞 ${blocked.length}`
    }
  }

  function buildWorkflowMap(nodeId, { scope = 'self' } = {}) {
    const root = rawNode(nodeId)
    const effectiveScope = normalizeScope(scope)
    const ids = effectiveScope === 'subtree' ? subtreeIds(nodeId) : [nodeId]
    const unitRows = ids.map((id) => rawNode(id)).filter((r) => READINESS_UNIT_TYPES.has(r.type))
    // 非需求节点（项目 / 任务组）用自身作为锚点，保证页面在任何节点都可打开；
    // 子树里有需求时，需求节点才是主线单元。
    const units = (unitRows.length > 0 ? unitRows : [root]).map(nodeVO)
    const stages = WORKFLOW_STAGES.map((s) => ({ ...s, items: [] }))
    const nodes = [
      {
        id: `root:${root.id}`,
        type: 'root',
        label: root.name,
        status: 'empty',
        detail: effectiveScope === 'subtree' ? '含子树' : '仅本节点',
        meta: { nodeId: root.id, nodeType: root.type, scope: effectiveScope }
      }
    ]
    const edges = []

    for (const stage of stages) {
      nodes.push({
        id: `stage:${stage.key}`,
        type: 'stage',
        stage: stage.key,
        label: stage.label,
        status: 'empty',
        detail: stage.group === 'release' ? '上线与检查扩展段' : '研发主线',
        meta: { group: stage.group }
      })
      edges.push({ from: `root:${root.id}`, to: `stage:${stage.key}`, kind: 'stage' })
    }

    const unitNodes = units.map((unit) => {
      const id = `unit:${unit.id}`
      nodes.push({
        id,
        type: 'unit',
        unitId: unit.id,
        label: unit.name,
        status: 'pass',
        detail: unit.path,
        meta: { nodeType: unit.type }
      })
      edges.push({ from: `root:${root.id}`, to: id, kind: 'unit' })
      return { ...unit, nodeId: id }
    })

    const branchItems = []
    for (const unit of unitNodes) {
      const docs = listDocuments(unit.id)
      const cases = listTestCases(unit.id, {})
      const reports = listTestReports(unit.id, { limit: 100 })
      const acceptance = buildAcceptanceReport(unit.id)
      const releaseItems = listReleaseItems(unit.id)
      let readiness = null
      if (READINESS_UNIT_TYPES.has(unit.type)) readiness = buildRequirementReadiness(unit.id)
      const check = (key) => readiness && readiness.items.find((i) => i.key === key)

      const requirementCheck = check('requirement_doc')
      const designCheck = check('design_doc')
      const docsFilled = docs.filter((d) => String(d.content || '').trim() !== '')
      const regressionCases = cases.filter((c) => c.kind === 'regression' || c.kind === 'acceptance')
      const codeCheckCases = cases.filter((c) => c.kind === 'code_check')
      const bizCheckCases = cases.filter((c) => c.kind === 'biz_check')
      const releaseCheckCases = cases.filter((c) => c.kind === 'release_check')
      const releaseCheckItems = releaseItems.filter((i) => i.kind === 'check')
      const releaseCheckItemSummary = mapReleaseItems(releaseCheckItems)
      const codeCheckMeta = checkCasesMeta(codeCheckCases, latestReportsByCase(unit.id, 'code_check'))
      const bizCheckMeta = checkCasesMeta(bizCheckCases, latestReportsByCase(unit.id, 'biz_check'))
      const releaseCheckMeta = checkCasesMeta(releaseCheckCases, latestReportsByCase(unit.id, 'release_check'))
      const releaseCheckStatus = workflowWorstStatus([
        { status: releaseCheckItemSummary.status },
        { status: workflowCheckStatus(releaseCheckMeta) }
      ])

      branchItems.push(
        workflowItem({
          stage: 'requirement',
          unit,
          status: requirementCheck ? (requirementCheck.passed ? 'pass' : 'fail') : docsFilled.length > 0 ? 'pass' : 'empty',
          detail: requirementCheck ? requirementCheck.detail : docsFilled.length > 0 ? `已填写 ${docsFilled.length} 份文档` : '暂无需求正文'
        }),
        workflowItem({
          stage: 'design',
          unit,
          status: designCheck ? (designCheck.passed ? 'pass' : 'fail') : 'empty',
          detail: designCheck ? designCheck.detail : '需求节点才有概要设计门禁'
        }),
        workflowItem({
          stage: 'documents',
          unit,
          // 空白预置文档只算“登记了文档”，不算通过证据。
          status: docs.length === 0 ? 'empty' : docsFilled.length > 0 ? 'pass' : 'fail',
          detail: `文档 ${docs.length} 份 · 已填写 ${docsFilled.length} 份`,
          meta: { documents: docs.map((d) => ({ id: d.id, name: d.name, filled: String(d.content || '').trim() !== '' })) }
        }),
        workflowItem({
          stage: 'mindmap',
          unit,
          status: 'pass',
          detail: '已在本视图可视化'
        }),
        workflowItem({
          stage: 'regression',
          unit,
          status: regressionCases.length > 0 ? 'pass' : 'empty',
          detail: `可回归用例 ${regressionCases.length} 条`,
          meta: { caseIds: regressionCases.map((c) => c.id), kinds: [...new Set(regressionCases.map((c) => c.kind))] }
        }),
        workflowItem({
          stage: 'test_report',
          unit,
          status: reports.length === 0 ? 'empty' : workflowWorstStatus(reports.map((r) => ({ status: mapReportStatus(r.status) }))),
          detail: reports.length === 0 ? '暂无报告' : `报告 ${reports.length} 条 · 最近 ${reports[0].status}`,
          meta: { latestReportId: reports[0] ? reports[0].id : null }
        }),
        workflowItem({
          stage: 'acceptance',
          unit,
          status:
            acceptance.totals.cases === 0
              ? 'empty'
              : acceptance.totals.fail +
                    acceptance.totals.blocked +
                    acceptance.totals.error +
                    acceptance.totals.cancelled +
                    acceptance.totals.running +
                    acceptance.totals.notRun >
                  0
                ? 'fail'
                : 'pass',
          detail:
            acceptance.totals.cases === 0
              ? '暂无验收样本'
              : `用例 ${acceptance.totals.cases} · 通过率 ${acceptance.passRate == null ? '—' : Math.round(acceptance.passRate * 100) + '%'}`,
          meta: acceptance.totals
        }),
        workflowItem({
          stage: 'release_config',
          unit,
          ...mapReleaseItems(releaseItems.filter((i) => i.kind === 'config')),
          meta: { releaseItems: releaseItemsMeta(releaseItems.filter((i) => i.kind === 'config')) }
        }),
        workflowItem({
          stage: 'release_sql',
          unit,
          ...mapReleaseItems(releaseItems.filter((i) => i.kind === 'sql')),
          meta: { releaseItems: releaseItemsMeta(releaseItems.filter((i) => i.kind === 'sql')) }
        }),
        workflowItem({
          stage: 'release_check',
          unit,
          status: releaseCheckStatus,
          detail:
            releaseCheckItems.length === 0 && releaseCheckCases.length === 0
              ? '暂无登记'
              : `检查项 ${releaseCheckItems.length} 项 · 检查用例 ${releaseCheckCases.length} 条 · ${releaseCheckItemSummary.detail}`,
          meta: {
            caseIds: releaseCheckCases.map((c) => c.id),
            releaseItems: releaseItemsMeta(releaseCheckItems),
            checkCases: releaseCheckMeta
          }
        }),
        workflowItem({
          stage: 'code_check',
          unit,
          status: workflowCheckStatus(codeCheckMeta),
          detail: codeCheckCases.length === 0 ? '暂无代码检查用例' : `代码检查用例 ${codeCheckCases.length} 条`,
          meta: {
            caseIds: codeCheckCases.map((c) => c.id),
            checkCases: codeCheckMeta
          }
        }),
        workflowItem({
          stage: 'biz_check',
          unit,
          status: workflowCheckStatus(bizCheckMeta),
          detail: bizCheckCases.length === 0 ? '暂无业务检查用例' : `业务检查用例 ${bizCheckCases.length} 条`,
          meta: {
            caseIds: bizCheckCases.map((c) => c.id),
            checkCases: bizCheckMeta
          }
        })
      )
    }

    for (const item of branchItems) {
      nodes.push(item)
      edges.push({ from: `stage:${item.stage}`, to: item.id, kind: 'branch' })
      edges.push({ from: `unit:${item.unitId}`, to: item.id, kind: 'evidence' })
    }

    for (const stage of stages) {
      const summary = workflowStageSummary(stage.key, branchItems)
      stage.status = summary.status
      stage.detail = summary.detail
      stage.counts = summary.counts
      stage.items = branchItems.filter((i) => i.stage === stage.key)
      const node = nodes.find((n) => n.id === `stage:${stage.key}`)
      if (node) {
        node.status = stage.status
        node.detail = stage.detail
        node.meta.counts = stage.counts
      }
    }

    // 根状态只聚合“证据阶段”，排除 mindmap 这类展示性阶段。
    const rootStatus = workflowWorstStatus(
      stages.filter((s) => WORKFLOW_EVIDENCE_STAGES.has(s.key)).map((s) => ({ status: s.status }))
    )
    const rootNode = nodes.find((n) => n.id === `root:${root.id}`)
    if (rootNode) rootNode.status = rootStatus

    const totals = {
      stages: stages.length,
      units: units.length,
      branches: branchItems.length,
      pass: branchItems.filter((i) => i.status === 'pass').length,
      fail: branchItems.filter((i) => i.status === 'fail').length,
      pending: branchItems.filter((i) => i.status === 'pending').length,
      empty: branchItems.filter((i) => i.status === 'empty').length
    }

    return {
      node: { id: root.id, name: root.name, type: root.type },
      scope: effectiveScope,
      status: rootStatus,
      totals,
      stages: stages.map((s) => ({
        key: s.key,
        label: s.label,
        group: s.group,
        status: s.status,
        detail: s.detail,
        counts: s.counts,
        items: s.items
      })),
      units: unitNodes.map((u) => ({ nodeId: u.nodeId, id: u.id, name: u.name, type: u.type, path: u.path })),
      nodes,
      edges
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
    // 组合写入（建 child run + 随 child 重开用例报告）合并为一次 revision 递增。
    let child
    withoutBump(() => {
      child = createAgentRun(
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
      // 重试是**一次新的执行**：父 run 的用例报告不能停在旧结论上。
      // 为父 run 关联的每条用例随 child run 开一条新的 running 报告——
      // ① 「一次执行 = 一行」，旧结论作为历史保留（不原地改写）；
      // ② child run 落终态时 finalizeReportsForRun 会收尾这条 running 报告，用例报告随之刷新；
      // ③ 验收报告按「最近一条」取结论，自动落到这次重试的结果上。
      // 若父 run 本就不带用例报告（普通 agent 任务），这里什么也不建。
      const parentReports = db.prepare('SELECT * FROM test_reports WHERE run_id = ? ORDER BY id').all(cur.id)
      for (const r of parentReports) {
        // createAgentRun 返回的是 VO（camelCase），节点字段是 nodeId
        createTestReport(
          child.nodeId,
          {
            caseId: r.case_id,
            runId: child.id,
            kind: r.kind,
            status: 'running',
            summary: `重试执行：run #${cur.id} → #${child.id}（第 ${child.attempt} 次）`
          },
          by
        )
      }
    })
    bumpRevision()
    return child
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
    documentOverview,
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
    FORMAT_VALUES,
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
    // 文档敏感信息扫描（只读安全前置判定）
    buildSecretScan,
    // 上线治理（上线配置 / 上线 SQL / 上线检查清单）
    RELEASE_ITEM_KINDS,
    createReleaseItem,
    listReleaseItems,
    getReleaseItem,
    upsertReleaseItem,
    updateReleaseItem,
    deleteReleaseItem,
    reorderReleaseItems,
    RELEASE_CHECK_CASE_KINDS,
    buildReleaseChecklist,
    // 上线 SQL 风险审查（上线检查的静态前置判定）
    buildReleaseSqlAudit,
    // 业务检查门禁（业务可验收性的只读判定）
    buildBusinessGate,
    // 交付门禁（汇总需求就绪 / 验收 / 上线结论）
    buildDeliveryGate,
    captureDeliverySnapshot,
    listDeliverySnapshots,
    getDeliverySnapshot,
    // 研发主线思维导图（只读投影：需求 → 设计/文档 → 回归 → 报告 → 验收 → 上线治理）
    WORKFLOW_STAGES,
    buildWorkflowMap,
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

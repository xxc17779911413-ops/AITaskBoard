const BASE = '/api'
const headers = { 'content-type': 'application/json' }

async function api(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, { headers, ...options })
  const body = await r.json()
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, details: body.error.details })
  return body
}

export default {
  // 健康 / schema / revision
  health: () => api('/health'),
  schema: () => api('/schema'),
  revision: () => api('/revision'),

  // 树
  tree: (format) => api(`/tree${format === 'md' ? '?format=md' : ''}`),

  // 节点
  nodeGet: (id) => api(`/nodes/${encodeURIComponent(id)}`),
  nodeCreate: (data) => api('/nodes', { method: 'POST', body: JSON.stringify(data) }),
  nodeUpdate: (id, data) => api(`/nodes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  nodeDelete: (id, confirm) => api(`/nodes/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm }) }),
  nodeReorder: (data) => api('/nodes/reorder', { method: 'POST', body: JSON.stringify(data) }),
  nodeUpsert: (data) => api('/nodes/upsert', { method: 'POST', body: JSON.stringify(data) }),
  batch: (data) => api('/batch', { method: 'POST', body: JSON.stringify(data) }),
  importOutline: (data) => api('/import', { method: 'POST', body: JSON.stringify(data) }),

  // 需求管理
  requirements: ({ projectId, status } = {}) => {
    const qs = new URLSearchParams()
    if (projectId) qs.set('projectId', projectId)
    if (status) qs.set('status', status)
    const suffix = qs.toString() ? `?${qs}` : ''
    return api(`/requirements${suffix}`)
  },
  requirementCreate: (data) => api('/requirements', { method: 'POST', body: JSON.stringify(data) }),
  requirementTransition: (id, status) =>
    api(`/requirements/${encodeURIComponent(id)}/transition`, {
      method: 'POST',
      body: JSON.stringify({ status })
    }),
  documentOverview: ({ projectId, status, q, docName, fill } = {}) => {
    const qs = new URLSearchParams()
    if (projectId) qs.set('projectId', projectId)
    if (status) qs.set('status', status)
    if (q) qs.set('q', q)
    if (docName) qs.set('docName', docName)
    if (fill) qs.set('fill', fill)
    const suffix = qs.toString() ? `?${qs}` : ''
    return api(`/documents/overview${suffix}`)
  },

  // 属性定义
  attrDefs: (nodeType) => api(`/attr-defs${nodeType ? `?nodeType=${nodeType}` : ''}`),
  attrDefCreate: (data) => api('/attr-defs', { method: 'POST', body: JSON.stringify(data) }),
  attrDefUpdate: (id, data) => api(`/attr-defs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  attrDefDelete: (id) => api(`/attr-defs/${id}`, { method: 'DELETE' }),

  // 文档
  docList: (nodeId) => api(`/nodes/${nodeId}/documents`),
  docCreate: (nodeId, data) => api(`/nodes/${nodeId}/documents`, { method: 'POST', body: JSON.stringify(data) }),
  docUpsert: (nodeId, data) => api(`/nodes/${nodeId}/documents/upsert`, { method: 'POST', body: JSON.stringify(data) }),
  docUpdate: (docId, data) => api(`/documents/${docId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  docDelete: (docId) => api(`/documents/${docId}`, { method: 'DELETE' }),
  docReorder: (nodeId, data) => api(`/nodes/${nodeId}/documents/reorder`, { method: 'POST', body: JSON.stringify(data) }),

  // 回归测试闭环（用例 / 运行 / 测试报告 / 验收报告）
  testCaseList: (nodeId, { kind, includeDisabled } = {}) => {
    const qs = new URLSearchParams()
    if (kind) qs.set('kind', kind)
    if (includeDisabled) qs.set('includeDisabled', 'true')
    const suffix = qs.toString() ? `?${qs}` : ''
    return api(`/nodes/${nodeId}/test-cases${suffix}`)
  },
  testCaseUpsert: (nodeId, data) => api(`/nodes/${nodeId}/test-cases/upsert`, { method: 'POST', body: JSON.stringify(data) }),
  testCaseUpdate: (caseId, data) => api(`/test-cases/${caseId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  testCaseRemove: (caseId) => api(`/test-cases/${caseId}`, { method: 'DELETE' }),
  testCaseReorder: (nodeId, orderedIds) =>
    api(`/nodes/${nodeId}/test-cases/reorder`, { method: 'POST', body: JSON.stringify({ orderedIds }) }),
  testRun: (nodeId, data) => api(`/nodes/${nodeId}/test-runs`, { method: 'POST', body: JSON.stringify(data) }),
  testReportList: (nodeId, { caseId, kind, limit } = {}) => {
    const qs = new URLSearchParams()
    if (caseId) qs.set('caseId', caseId)
    if (kind) qs.set('kind', kind)
    if (limit) qs.set('limit', limit)
    const suffix = qs.toString() ? `?${qs}` : ''
    return api(`/nodes/${nodeId}/test-reports${suffix}`)
  },
  testReportGet: (reportId) => api(`/test-reports/${reportId}`),
  testReportFinish: (reportId, data) => api(`/test-reports/${reportId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  acceptanceReport: (nodeId, { scope } = {}) => api(`/nodes/${nodeId}/acceptance-report${scope ? `?scope=${scope}` : ''}`),
  acceptanceConclusion: (nodeId, { scope, version } = {}) => {
    const qs = new URLSearchParams()
    if (scope) qs.set('scope', scope)
    if (version) qs.set('version', version)
    return api(`/nodes/${nodeId}/acceptance-conclusion${qs.toString() ? `?${qs}` : ''}`)
  },
  structureGraph: (nodeId, { scope, type, status, ready, hasGap, caseStatus, q } = {}) => {
    const qs = new URLSearchParams()
    if (scope) qs.set('scope', scope)
    if (type) qs.set('type', type)
    if (status) qs.set('status', status)
    if (ready !== undefined && ready !== null && ready !== '') qs.set('ready', ready)
    if (hasGap !== undefined && hasGap !== null && hasGap !== '') qs.set('hasGap', hasGap)
    if (caseStatus) qs.set('caseStatus', caseStatus)
    if (q) qs.set('q', q)
    return api(`/nodes/${nodeId}/structure-graph${qs.toString() ? `?${qs}` : ''}`)
  },

  // 操作审计日志（只读）
  auditLogs: ({ action, nodeId, decision, limit } = {}) => {
    const qs = new URLSearchParams()
    if (action) qs.set('action', action)
    if (nodeId) qs.set('nodeId', nodeId)
    if (decision) qs.set('decision', decision)
    if (limit) qs.set('limit', limit)
    return api(`/audit-logs${qs.toString() ? `?${qs}` : ''}`)
  },

  // 上线治理（上线配置 / 上线 SQL / 上线检查清单）
  releaseItemList: (nodeId, { kind, status, includeOptional } = {}) => {
    const qs = new URLSearchParams()
    if (kind) qs.set('kind', kind)
    if (status) qs.set('status', status)
    if (includeOptional === false) qs.set('includeOptional', 'false')
    return api(`/nodes/${nodeId}/release-items${qs.toString() ? `?${qs}` : ''}`)
  },
  releaseItemUpsert: (nodeId, data) => api(`/nodes/${nodeId}/release-items/upsert`, { method: 'POST', body: JSON.stringify(data) }),
  releaseItemUpdate: (id, data) => api(`/release-items/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  releaseItemRemove: (id) => api(`/release-items/${id}`, { method: 'DELETE' }),
  releaseChecklist: (nodeId, { scope } = {}) => api(`/nodes/${nodeId}/release-checklist${scope ? `?scope=${scope}` : ''}`),
  releaseCheck: (nodeId, data) => api(`/nodes/${nodeId}/release-checks`, { method: 'POST', body: JSON.stringify(data) }),

  // 交付门禁
  deliveryGate: (nodeId, scope) => api(`/nodes/${nodeId}/delivery-gate?scope=${scope || 'self'}`),

  // commit
  commitList: (nodeId, subtree) => api(`/nodes/${nodeId}/commits${subtree ? '?subtree=true' : ''}`),
  commitAdd: (nodeId, data) => api(`/nodes/${nodeId}/commits`, { method: 'POST', body: JSON.stringify(data) }),
  commitDelete: (cid) => api(`/commits/${cid}`, { method: 'DELETE' }),
  commitDiff: (cid) => api(`/commits/${cid}/diff`),
  nodeDiffs: (nodeId, scope) => api(`/nodes/${nodeId}/diffs?scope=${scope || 'self'}`),
  commitTrack: (cid) => api(`/commits/${cid}/track`),
  nodeTracks: (nodeId, scope, opts = {}) => api(`/nodes/${nodeId}/tracks?scope=${scope || 'self'}${opts.branches ? '&branches=true' : ''}`),
  commitDuplicates: (nodeId, scope) => api(`/nodes/${nodeId}/duplicates?scope=${scope || 'self'}`),
  commitDedupe: (payload) => api('/commits/dedupe', { method: 'POST', body: JSON.stringify(payload) }),

  // IDE 桥：请求 IDEA 打开 diff（插件轮询领取）
  ideOpenDiff: (payload) => api('/ide/open-diff', { method: 'POST', body: JSON.stringify(payload) }),

  // 仓库
  repos: () => api('/repos'),
  repoCreate: (data) => api('/repos', { method: 'POST', body: JSON.stringify(data) }),
  repoUpdate: (id, data) => api(`/repos/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  repoDelete: (id) => api(`/repos/${id}`, { method: 'DELETE' }),

  // 标签级分支配置
  branchConfigs: () => api('/branch-configs'),
  branchConfigSet: (tag, data) => api(`/branch-configs/${encodeURIComponent(tag)}`, { method: 'PUT', body: JSON.stringify(data) }),
  branchConfigRemove: (tag) => api(`/branch-configs/${encodeURIComponent(tag)}`, { method: 'DELETE' }),

  // 配置
  configGet: () => api('/config'),
  configSet: (data) => api('/config', { method: 'PUT', body: JSON.stringify(data) }),
  configGitlabTest: () => api('/config/gitlab/test', { method: 'POST' })
}

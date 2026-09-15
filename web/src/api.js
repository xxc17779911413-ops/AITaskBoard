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
  docVersions: (docId) => api(`/documents/${docId}/versions`),
  docRestore: (docId, versionId) => api(`/documents/${docId}/versions/${versionId}/restore`, { method: 'POST', body: '{}' }),
  docDelete: (docId) => api(`/documents/${docId}`, { method: 'DELETE' }),
  docReorder: (nodeId, data) => api(`/nodes/${nodeId}/documents/reorder`, { method: 'POST', body: JSON.stringify(data) }),

  // 文档图片上传（base64 JSON）→ { url: "/uploads/<name>" }
  uploadImage: (data) => api('/uploads', { method: 'POST', body: JSON.stringify(data) }),

  // 交付门禁
  deliveryGate: (nodeId, scope) => api(`/nodes/${nodeId}/delivery-gate?scope=${scope || 'self'}`),
  acceptanceStatus: (nodeId, scope) => api(`/nodes/${nodeId}/acceptance-status?scope=${scope || 'self'}`),
  acceptanceSign: (nodeId, data) => api(`/nodes/${nodeId}/acceptance-signoff`, { method: 'POST', body: JSON.stringify(data) }),

  // 概要设计大纲 / 思维导图
  designOutline: (nodeId, scope) => api(`/nodes/${nodeId}/design-outline?scope=${scope || 'self'}`),
  designOutlineApply: (nodeId, data) => api(`/nodes/${nodeId}/design-outline/apply`, { method: 'POST', body: JSON.stringify(data || {}) }),
  // 思维导图（树 → mermaid mindmap 只读投影）
  mindmap: (nodeId, scope, maxDepth) =>
    api(
      `/nodes/${nodeId}/mindmap?scope=${scope || 'self'}${maxDepth ? `&maxDepth=${maxDepth}` : ''}`
    ),
  deliverySnapshotCapture: (nodeId, data) =>
    api(`/nodes/${nodeId}/delivery-snapshots`, { method: 'POST', body: JSON.stringify(data) }),
  deliverySnapshots: (nodeId, scope) =>
    api(`/nodes/${nodeId}/delivery-snapshots${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`),

  // 代码检查（已登记提交新增行的只读静态审查）
  codeAudit: (nodeId, scope) => api(`/nodes/${nodeId}/code-audit?scope=${scope || 'self'}`),

  // 业务检查门禁
  businessGate: (nodeId, scope) => api(`/nodes/${nodeId}/business-gate?scope=${scope || 'self'}`),

  // 研发主线思维导图
  workflowMap: (nodeId, scope) => api(`/nodes/${nodeId}/workflow-map?scope=${scope || 'self'}`),

  // 上线治理（同步自既有 release_* / test_* 接口）
  releaseItems: (nodeId, params = {}) => {
    const qs = new URLSearchParams()
    if (params.kind) qs.set('kind', params.kind)
    if (params.status) qs.set('status', params.status)
    if (params.includeOptional !== undefined) qs.set('includeOptional', String(params.includeOptional))
    const query = qs.toString()
    return api(`/nodes/${nodeId}/release-items${query ? `?${query}` : ''}`)
  },
  releaseChecklist: (nodeId, scope) => api(`/nodes/${nodeId}/release-checklist?scope=${scope || 'self'}`),
  releaseItemUpdate: (rid, data) => api(`/release-items/${rid}`, { method: 'PATCH', body: JSON.stringify(data) }),
  releaseCheck: (nodeId, data) => api(`/nodes/${nodeId}/release-checks`, { method: 'POST', body: JSON.stringify(data) }),
  testReports: (nodeId, params = {}) => {
    const qs = new URLSearchParams()
    if (params.caseId) qs.set('caseId', String(params.caseId))
    if (params.kind) qs.set('kind', params.kind)
    if (params.limit) qs.set('limit', String(params.limit))
    const query = qs.toString()
    return api(`/nodes/${nodeId}/test-reports${query ? `?${query}` : ''}`)
  },
  testReportFinish: (rid, data) => api(`/test-reports/${rid}`, { method: 'PATCH', body: JSON.stringify(data) }),

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

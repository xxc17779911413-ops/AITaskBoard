/**
 * 结构探索图谱的展示口径（纯函数，便于 UT 覆盖）。
 *
 * 数据来自 store.buildStructureGraph —— 树 + 每节点的文档缺口 / 用例最近结论 / 需求就绪状态。
 * 这里只做展示映射与不变量校验，不重算业务口径。
 */

export const STRUCTURE_TYPES = ['project', 'requirement', 'subreq', 'group', 'task', 'defect']
export const STRUCTURE_CASE_STATUSES = ['pass', 'fail', 'not_run', 'running']

const TYPE_LABELS = {
  project: '项目',
  requirement: '需求',
  subreq: '子需求',
  group: '任务组',
  task: '子任务',
  defect: '缺陷'
}

const CASE_STATUS_LABELS = { pass: '通过', fail: '未通过', running: '执行中', not_run: '未执行' }
const CASE_STATUS_TYPES = { pass: 'success', fail: 'danger', running: 'warning', not_run: 'info' }

export const structureTypeLabel = (t) => TYPE_LABELS[t] || t || '—'
export const structureCaseStatusLabel = (s) => CASE_STATUS_LABELS[s] || (s == null ? '—' : s)
export const structureCaseStatusType = (s) => CASE_STATUS_TYPES[s] || 'info'

/** 需求两层的就绪标签：null（不适用）显示「—」而不是「未就绪」 */
export const structureReadyLabel = (ready) => (ready == null ? '—' : ready ? '就绪' : '未就绪')
export const structureReadyTagType = (ready) => (ready == null ? 'info' : ready ? 'success' : 'danger')

/** 文档缺口文案：需求两层才判缺口，其它类型只报篇数 */
export function structureDocText(node) {
  if (node.type !== 'requirement' && node.type !== 'subreq') return `${node.documentCount ?? 0} 篇`
  if (!node.hasGap) return '齐'
  return `缺 ${(node.documentGaps || []).map((g) => g.name).join('、')}`
}

/** 用例文案：无用例显示「—」，否则「N（最近结论）」 */
export function structureCaseText(node) {
  if (!node.caseCount) return '—'
  return `${node.caseCount}（${structureCaseStatusLabel(node.caseStatus)}）`
}

/** 筛选是否生效：任一筛选项非空即视为筛选态，用于「已筛选」提示 */
export function structureFilterActive(filters = {}) {
  return Object.values(filters).some((v) => v !== null && v !== undefined && v !== '')
}

/**
 * 图谱 → KPI 列表（缺字段按 0）。
 * `nodes` 为筛选后节点数，`total` 为筛选前；两者不等时 UI 应提示「已筛选」。
 */
export function buildStructureKpi(totals = {}) {
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return [
    { key: 'nodes', title: '节点', value: num(totals.nodes) },
    { key: 'total', title: '范围内', value: num(totals.total) },
    { key: 'edges', title: '连接', value: num(totals.edges) },
    { key: 'depth', title: '深度', value: num(totals.depth) },
    { key: 'gapNodes', title: '文档缺口', value: num(totals.gapNodes) },
    { key: 'notReadyNodes', title: '未就绪', value: num(totals.notReadyNodes) },
    { key: 'caseIssueNodes', title: '用例待处理', value: num(totals.caseIssueNodes) }
  ]
}

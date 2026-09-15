/**
 * 操作审计的展示口径（纯函数，便于 UT 覆盖）。
 *
 * 数据来自 store.listAuditLogs —— 高风险操作（release.check / regression.run /
 * requirement.transition / release.item.write）的 allowed / denied / confirmed / pending 留痕。
 */

export const AUDIT_ACTIONS = ['release.check', 'regression.run', 'requirement.transition', 'release.item.write']
export const AUDIT_DECISIONS = ['allowed', 'denied', 'confirmed', 'pending']

const ACTION_LABELS = {
  'release.check': '上线检查',
  'regression.run': '回归派单',
  'requirement.transition': '状态流转',
  'release.item.write': '配置/SQL 变更'
}

const DECISION_LABELS = { allowed: '放行', denied: '拒绝', confirmed: '已确认', pending: '待确认' }
const DECISION_TYPES = { allowed: 'success', denied: 'danger', confirmed: 'primary', pending: 'warning' }

export const auditActionLabel = (a) => ACTION_LABELS[a] || a || '—'
export const auditDecisionLabel = (d) => DECISION_LABELS[d] || d || '—'
export const auditDecisionType = (d) => DECISION_TYPES[d] || 'info'

/** 审计 KPI（缺字段按 0）：总数与四个结论分桶 */
export function buildAuditKpi(logs = []) {
  const list = Array.isArray(logs) ? logs : []
  const count = (d) => list.filter((l) => l.decision === d).length
  return [
    { key: 'total', title: '总记录', value: list.length },
    { key: 'allowed', title: '放行', value: count('allowed') },
    { key: 'confirmed', title: '已确认', value: count('confirmed') },
    { key: 'denied', title: '拒绝', value: count('denied') },
    { key: 'pending', title: '待确认', value: count('pending') }
  ]
}

/** 审计按 action 分桶（供筛选下拉与概览） */
export function auditActionCounts(logs = []) {
  const out = {}
  for (const l of Array.isArray(logs) ? logs : []) {
    out[l.action] = (out[l.action] || 0) + 1
  }
  return out
}

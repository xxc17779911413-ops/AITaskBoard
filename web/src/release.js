/**
 * 上线就绪检查的展示口径（纯函数，便于 UT 覆盖）。
 *
 * 数据来自 store.buildReleaseChecklist：
 *   ready = 必做上线项全部 done/skipped **且** 所有启用中的 code/biz/release_check 用例最近一次为 pass；
 *   空态收紧为「既无必做项也无检查用例」才 ready=null。
 */

export const RELEASE_ITEM_KINDS = ['config', 'sql', 'check']
export const RELEASE_ITEM_STATUSES = ['pending', 'ready', 'done', 'blocked', 'skipped']
export const RELEASE_CHECK_CASE_KINDS = ['code_check', 'biz_check', 'release_check']

const KIND_LABELS = { config: '上线配置', sql: '上线 SQL', check: '上线检查' }
const STATUS_LABELS = { pending: '待处理', ready: '就绪', done: '已完成', blocked: '阻塞', skipped: '跳过' }
const CASE_KIND_LABELS = { code_check: '代码检查', biz_check: '业务检查', release_check: '上线检查' }

export const releaseItemKindLabel = (k) => KIND_LABELS[k] || k || '—'
export const releaseItemStatusLabel = (s) => STATUS_LABELS[s] || s || '—'
export const releaseCaseKindLabel = (k) => CASE_KIND_LABELS[k] || k || '—'

export function releaseStatusTagType(status) {
  return { done: 'success', skipped: 'info', blocked: 'danger', ready: 'warning', pending: 'warning' }[status] || 'info'
}

/** 上线就绪结论标签：ready=null 显示「无必做项」而不是伪造成未就绪 */
export function releaseReadyText(ready) {
  if (ready == null) return '无必做项'
  return ready ? '可上线' : '未就绪'
}

export function releaseReadyTagType(ready) {
  if (ready == null) return 'info'
  return ready ? 'success' : 'danger'
}

/** 清单 totals → KPI 列表（缺字段按 0），含检查用例分桶 */
export function buildReleaseKpi(totals = {}) {
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return [
    { key: 'items', title: '上线项', value: num(totals.items) },
    { key: 'required', title: '必做', value: num(totals.required) },
    { key: 'done', title: '已完成', value: num(totals.done) },
    { key: 'skipped', title: '跳过', value: num(totals.skipped) },
    { key: 'blocked', title: '阻塞', value: num(totals.blocked) },
    { key: 'pending', title: '待处理', value: num(totals.pending) },
    { key: 'checkCases', title: '检查用例', value: num(totals.checkCases) },
    { key: 'checkPass', title: '检查通过', value: num(totals.checkPass) },
    { key: 'checkPending', title: '检查未执行', value: num(totals.checkPending) },
    { key: 'checkRunning', title: '检查执行中', value: num(totals.checkRunning) }
  ]
}

/** 上线阻塞项总数 = 必做项阻塞 + 检查用例阻塞，供 UI/UT 对账 */
export function releaseBlockerCount(checklist = {}) {
  const items = Array.isArray(checklist.blockers) ? checklist.blockers.length : 0
  const cases = Array.isArray(checklist.caseBlockers) ? checklist.caseBlockers.length : 0
  return items + cases
}

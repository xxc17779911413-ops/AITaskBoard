/**
 * 回归测试闭环的展示口径（纯函数，便于 UT 覆盖）。
 *
 * 数据来自 store.buildAcceptanceReport 的 totals：
 *   pass + fail + blocked + error + cancelled + running + notRun = cases
 * 通过率是「已完结」口径：running / notRun 都不进分母；无完结时为 null（展示为「—」）。
 */

export const TEST_CASE_KINDS = ['regression', 'acceptance', 'code_check', 'biz_check', 'release_check']

export const REPORT_STATUSES = ['running', 'pass', 'fail', 'blocked', 'error', 'cancelled']

const CASE_KIND_LABELS = {
  regression: '回归',
  acceptance: '验收',
  code_check: '代码检查',
  biz_check: '业务检查',
  release_check: '上线检查'
}

const REPORT_STATUS_LABELS = {
  running: '执行中',
  pass: '通过',
  fail: '失败',
  blocked: '阻塞',
  error: '异常',
  cancelled: '取消'
}

const REPORT_STATUS_TYPES = {
  running: 'warning',
  pass: 'success',
  fail: 'danger',
  blocked: 'warning',
  error: 'danger',
  cancelled: 'info'
}

/** 用例的「最近结果」标签：未派单过用 not_run，避免显示成空 */
export const reportStatusLabel = (s) => REPORT_STATUS_LABELS[s] || (s === 'not_run' ? '未执行' : s || '—')
export const reportStatusType = (s) => REPORT_STATUS_TYPES[s] || (s === 'not_run' ? 'info' : 'info')
export const caseKindLabel = (k) => CASE_KIND_LABELS[k] || k || '—'

/** 通过率（0.5 → 50%）；null / 非法 → 「—」，表示没有已完结用例而不是 0% */
export function passRateText(rate) {
  const n = Number(rate)
  if (rate == null || !Number.isFinite(n)) return '—'
  return `${Math.round(n * 100)}%`
}

/**
 * 验收 totals → KPI 列表。顺序固定，缺字段按 0，避免 undefined 渲染。
 * settled 为通过率分母；cases 为启用中的用例总数。
 */
export function buildAcceptanceKpi(totals = {}) {
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return [
    { key: 'cases', title: '用例', value: num(totals.cases) },
    { key: 'settled', title: '已完结', value: num(totals.settled) },
    { key: 'pass', title: '通过', value: num(totals.pass) },
    { key: 'fail', title: '失败', value: num(totals.fail) },
    { key: 'blocked', title: '阻塞', value: num(totals.blocked) },
    { key: 'error', title: '异常', value: num(totals.error) },
    { key: 'running', title: '执行中', value: num(totals.running) },
    { key: 'notRun', title: '未执行', value: num(totals.notRun) },
    { key: 'passRate', title: '通过率', value: passRateText(totals.passRate) }
  ]
}

/** 分桶总数是否守恒——用于在 UI/UT 上守住「不少算也不重算」 */
export function acceptanceBucketsConserved(totals = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const sum =
    num(totals.pass) +
    num(totals.fail) +
    num(totals.blocked) +
    num(totals.error) +
    num(totals.cancelled) +
    num(totals.running) +
    num(totals.notRun)
  return sum === num(totals.cases)
}

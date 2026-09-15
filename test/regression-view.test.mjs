import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAcceptanceKpi,
  acceptanceBucketsConserved,
  passRateText,
  reportStatusLabel,
  reportStatusType,
  caseKindLabel,
  TEST_CASE_KINDS,
  REPORT_STATUSES
} from '../web/src/regression.js'

test('regression view：kind / 报告状态值域与后端一致', () => {
  assert.deepEqual(TEST_CASE_KINDS, ['regression', 'acceptance', 'code_check', 'biz_check', 'release_check'])
  assert.deepEqual(REPORT_STATUSES, ['running', 'pass', 'fail', 'blocked', 'error', 'cancelled'])
})

test('regression view：通过率为已完结口径，null 展示为 — 而不是 0%', () => {
  assert.equal(passRateText(null), '—')
  assert.equal(passRateText(undefined), '—')
  assert.equal(passRateText(0), '0%')
  assert.equal(passRateText(0.5), '50%')
  assert.equal(passRateText(1), '100%')
  assert.equal(passRateText(2 / 3), '67%')
})

test('regression view：KPI 覆盖全部分桶且缺字段按 0，不产生 NaN', () => {
  const kpis = buildAcceptanceKpi({
    cases: 3,
    settled: 2,
    pass: 1,
    fail: 1,
    blocked: 0,
    error: 0,
    cancelled: 0,
    running: 0,
    notRun: 1,
    passRate: 0.5
  })
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k.value]))
  assert.equal(byKey.cases, 3)
  assert.equal(byKey.settled, 2)
  assert.equal(byKey.passRate, '50%')
  const empty = buildAcceptanceKpi({})
  assert.equal(empty.every((k) => k.value === 0 || k.value === '—'), true)
})

test('regression view：分桶总数守恒校验', () => {
  assert.equal(
    acceptanceBucketsConserved({ cases: 3, pass: 1, fail: 1, blocked: 0, error: 0, cancelled: 0, running: 0, notRun: 1 }),
    true
  )
  // running + notRun 都计入 cases，漏算会被判为不守恒
  assert.equal(
    acceptanceBucketsConserved({ cases: 3, pass: 1, fail: 1, blocked: 0, error: 0, cancelled: 0, running: 0, notRun: 0 }),
    false
  )
})

test('regression view：最近结果标签把 not_run 显示为未执行', () => {
  assert.equal(reportStatusLabel('not_run'), '未执行')
  assert.equal(reportStatusLabel('pass'), '通过')
  assert.equal(reportStatusLabel('running'), '执行中')
  assert.equal(reportStatusType('pass'), 'success')
  assert.equal(reportStatusType('fail'), 'danger')
  assert.equal(reportStatusType('not_run'), 'info')
  assert.equal(caseKindLabel('code_check'), '代码检查')
  assert.equal(caseKindLabel('regression'), '回归')
})

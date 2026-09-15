import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReleaseKpi,
  releaseBlockerCount,
  releaseItemKindLabel,
  releaseItemStatusLabel,
  releaseCaseKindLabel,
  releaseReadyText,
  releaseReadyTagType,
  releaseStatusTagType,
  RELEASE_ITEM_KINDS,
  RELEASE_ITEM_STATUSES,
  RELEASE_CHECK_CASE_KINDS
} from '../web/src/release.js'

test('release view：值域与后端一致', () => {
  assert.deepEqual(RELEASE_ITEM_KINDS, ['config', 'sql', 'check'])
  assert.deepEqual(RELEASE_ITEM_STATUSES, ['pending', 'ready', 'done', 'blocked', 'skipped'])
  assert.deepEqual(RELEASE_CHECK_CASE_KINDS, ['code_check', 'biz_check', 'release_check'])
})

test('release view：就绪标签把 null 显示为「无必做项」而不是未就绪', () => {
  assert.equal(releaseReadyText(null), '无必做项')
  assert.equal(releaseReadyText(true), '可上线')
  assert.equal(releaseReadyText(false), '未就绪')
  assert.equal(releaseReadyTagType(null), 'info')
  assert.equal(releaseReadyTagType(true), 'success')
  assert.equal(releaseReadyTagType(false), 'danger')
})

test('release view：KPI 覆盖上线项与检查用例分桶，缺字段按 0', () => {
  const kpis = buildReleaseKpi({
    items: 3,
    required: 2,
    done: 1,
    skipped: 0,
    blocked: 1,
    pending: 1,
    checkCases: 2,
    checkPass: 1,
    checkPending: 1,
    checkRunning: 0
  })
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k.value]))
  assert.equal(byKey.items, 3)
  assert.equal(byKey.checkCases, 2)
  assert.equal(byKey.checkPending, 1)
  const empty = buildReleaseKpi({})
  assert.equal(empty.every((k) => k.value === 0), true)
})

test('release view：阻塞项总数 = 必做项阻塞 + 检查用例阻塞', () => {
  assert.equal(releaseBlockerCount({ blockers: [{ id: 1 }], caseBlockers: [{ caseId: 2 }, { caseId: 3 }] }), 3)
  assert.equal(releaseBlockerCount({}), 0)
  assert.equal(releaseBlockerCount({ blockers: [], caseBlockers: [] }), 0)
})

test('release view：类型 / 状态标签', () => {
  assert.equal(releaseItemKindLabel('sql'), '上线 SQL')
  assert.equal(releaseItemKindLabel('config'), '上线配置')
  assert.equal(releaseItemStatusLabel('done'), '已完成')
  assert.equal(releaseItemStatusLabel('blocked'), '阻塞')
  assert.equal(releaseCaseKindLabel('code_check'), '代码检查')
  assert.equal(releaseStatusTagType('blocked'), 'danger')
  assert.equal(releaseStatusTagType('done'), 'success')
})

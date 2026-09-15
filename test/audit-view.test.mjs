import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_ACTIONS,
  AUDIT_DECISIONS,
  auditActionCounts,
  auditActionLabel,
  auditDecisionLabel,
  auditDecisionType,
  buildAuditKpi
} from '../web/src/audit.js'

test('audit view：值域与后端一致', () => {
  assert.deepEqual(AUDIT_ACTIONS, ['release.check', 'regression.run', 'requirement.transition', 'release.item.write'])
  assert.deepEqual(AUDIT_DECISIONS, ['allowed', 'denied', 'confirmed', 'pending'])
})

test('audit view：操作与结论标签', () => {
  assert.equal(auditActionLabel('release.check'), '上线检查')
  assert.equal(auditActionLabel('release.item.write'), '配置/SQL 变更')
  assert.equal(auditDecisionLabel('denied'), '拒绝')
  assert.equal(auditDecisionLabel('confirmed'), '已确认')
  assert.equal(auditDecisionType('denied'), 'danger')
  assert.equal(auditDecisionType('confirmed'), 'primary')
})

test('audit view：KPI 分桶与总数', () => {
  const logs = [
    { action: 'regression.run', decision: 'allowed' },
    { action: 'regression.run', decision: 'confirmed' },
    { action: 'release.check', decision: 'denied' },
    { action: 'release.item.write', decision: 'denied' }
  ]
  const kpis = buildAuditKpi(logs)
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k.value]))
  assert.equal(byKey.total, 4)
  assert.equal(byKey.allowed, 1)
  assert.equal(byKey.confirmed, 1)
  assert.equal(byKey.denied, 2)
  assert.equal(byKey.pending, 0)
  assert.equal(buildAuditKpi({}).every((k) => k.value === 0), true)
})

test('audit view：按 action 计数', () => {
  const counts = auditActionCounts([
    { action: 'regression.run' },
    { action: 'regression.run' },
    { action: 'release.check' }
  ])
  assert.equal(counts['regression.run'], 2)
  assert.equal(counts['release.check'], 1)
  assert.deepEqual(auditActionCounts({}), {})
})

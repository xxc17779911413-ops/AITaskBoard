import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDocumentKpi } from '../web/src/documentKpi.js'

const summary = {
  requirementCount: 2,
  documentCount: 4,
  requiredSlotCount: 4,
  filledRequiredSlotCount: 1,
  emptyRequiredSlotCount: 3,
  unlinkedRequiredSlotCount: 0,
  gapRequirementCount: 2,
  filteredDocumentCount: 2,
  filteredGapCount: 1
}

test('document KPI：无筛选时展示 scope 级统计', () => {
  const kpis = buildDocumentKpi(summary, { filtered: false })
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k.value]))
  assert.equal(byKey.documentCount, 4)
  assert.equal(byKey.gapRequirementCount, 2)
  assert.equal(kpis.find((k) => k.key === 'documentCount').title, '文档数')
})

test('document KPI：筛选态展示 filtered* 与列表一致', () => {
  const kpis = buildDocumentKpi(summary, { filtered: true })
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k.value]))
  assert.equal(byKey.documentCount, 2)
  assert.equal(byKey.gapRequirementCount, 1)
  assert.equal(kpis.find((k) => k.key === 'documentCount').title, '筛选文档')
  assert.equal(kpis.find((k) => k.key === 'gapRequirementCount').title, '筛选缺口')
})

test('document KPI：缺字段 / 非数字按 0 处理，不产生 NaN', () => {
  const kpis = buildDocumentKpi({}, { filtered: true })
  assert.equal(kpis.every((k) => Number.isFinite(k.value)), true)
  assert.equal(kpis.every((k) => k.value === 0), true)
})

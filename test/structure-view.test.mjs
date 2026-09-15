import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STRUCTURE_TYPES,
  STRUCTURE_CASE_STATUSES,
  buildStructureKpi,
  structureCaseStatusLabel,
  structureCaseStatusType,
  structureCaseText,
  structureDocText,
  structureFilterActive,
  structureReadyLabel,
  structureReadyTagType,
  structureTypeLabel
} from '../web/src/structure.js'

test('structure view：值域与后端一致', () => {
  assert.deepEqual(STRUCTURE_TYPES, ['project', 'requirement', 'subreq', 'group', 'task', 'defect'])
  assert.deepEqual(STRUCTURE_CASE_STATUSES, ['pass', 'fail', 'not_run', 'running'])
})

test('structure view：就绪标签把 null 显示为「—」而不是未就绪', () => {
  assert.equal(structureReadyLabel(null), '—')
  assert.equal(structureReadyLabel(true), '就绪')
  assert.equal(structureReadyLabel(false), '未就绪')
  assert.equal(structureReadyTagType(null), 'info')
  assert.equal(structureReadyTagType(true), 'success')
  assert.equal(structureReadyTagType(false), 'danger')
})

test('structure view：文档缺口文案（需求两层判缺口，其它只报篇数）', () => {
  assert.equal(structureDocText({ type: 'requirement', hasGap: false, documentCount: 2 }), '齐')
  assert.equal(
    structureDocText({ type: 'subreq', hasGap: true, documentGaps: [{ name: '概要设计' }] }),
    '缺 概要设计'
  )
  assert.equal(structureDocText({ type: 'task', documentCount: 3 }), '3 篇')
})

test('structure view：用例文案', () => {
  assert.equal(structureCaseText({ caseCount: 0 }), '—')
  assert.equal(structureCaseText({ caseCount: 2, caseStatus: 'fail' }), '2（未通过）')
  assert.equal(structureCaseText({ caseCount: 1, caseStatus: 'running' }), '1（执行中）')
  assert.equal(structureCaseStatusLabel('not_run'), '未执行')
  assert.equal(structureCaseStatusType('fail'), 'danger')
  assert.equal(structureCaseStatusType('pass'), 'success')
})

test('structure view：筛选生效判定与 KPI', () => {
  assert.equal(structureFilterActive({}), false)
  assert.equal(structureFilterActive({ type: '', ready: null }), false)
  assert.equal(structureFilterActive({ hasGap: 'true' }), true)
  const kpis = buildStructureKpi({ nodes: 3, total: 5, edges: 2, depth: 2, gapNodes: 1, notReadyNodes: 1, caseIssueNodes: 1 })
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k.value]))
  assert.equal(byKey.nodes, 3)
  assert.equal(byKey.total, 5)
  assert.equal(byKey.gapNodes, 1)
  const empty = buildStructureKpi({})
  assert.equal(empty.every((k) => k.value === 0), true)
  assert.equal(structureTypeLabel('subreq'), '子需求')
})

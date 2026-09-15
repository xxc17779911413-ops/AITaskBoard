import test from 'node:test'
import assert from 'node:assert/strict'
import { tempHome } from './helpers.mjs'

async function setup() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p1 = store.createNode({ type: 'project', name: '项目A' })
  const p2 = store.createNode({ type: 'project', name: '项目B' })
  const a = store.createRequirement({ projectId: p1.id, name: '需求A' })
  const b = store.createRequirement({ projectId: p1.id, name: '需求B' })
  const c = store.createRequirement({ projectId: p2.id, name: '需求C' })
  return { tmp, store, p1, p2, a, b, c }
}

test('document overview：集中列出需求文档并统计核心槽位缺口', async () => {
  const { tmp, store, p1, a, b } = await setup()
  store.upsertDocument(a.id, '需求内容', 'A 的需求正文')
  store.createDocument(a.id, '补充说明', '自定义文档')

  const out = store.documentOverview({ projectId: p1.id })
  assert.equal(out.expectedDocNames.length, 2)
  assert.equal(out.summary.requirementCount, 2)
  assert.equal(out.summary.requiredSlotCount, 4)
  assert.equal(out.summary.filledRequiredSlotCount, 1)
  assert.equal(out.summary.emptyRequiredSlotCount, 3)
  assert.equal(out.summary.unlinkedRequiredSlotCount, 0)
  assert.equal(out.summary.gapRequirementCount, 2)
  assert.equal(out.items.length, 5)
  assert.equal(out.gaps.length, 3)
  assert.equal(out.gaps.every((g) => g.gapType === 'empty'), true)
  assert.deepEqual(new Set(out.gaps.map((g) => `${g.nodeName}:${g.docName}`)), new Set(['需求A:概要设计', '需求B:需求内容', '需求B:概要设计']))
  tmp.cleanup()
})

test('document overview：按关键词 / 文档名 / 填充状态筛选，summary 与筛选结果一致', async () => {
  const { tmp, store, p1, a, b } = await setup()
  store.upsertDocument(a.id, '需求内容', '充电订单导出')
  store.upsertDocument(b.id, '需求内容', '供电服务')
  store.upsertDocument(b.id, '概要设计', '订单导出设计')

  const q = store.documentOverview({ projectId: p1.id, q: '导出' })
  assert.equal(q.summary.filteredDocumentCount, q.items.length)
  assert.equal(q.items.every((d) => [d.name, d.content, d.nodeName, d.path].some((v) => String(v).includes('导出'))), true)

  const named = store.documentOverview({ projectId: p1.id, docName: '概要设计' })
  assert.equal(named.items.length, 2)
  assert.equal(named.gaps.length, 1)

  const filled = store.documentOverview({ projectId: p1.id, fill: 'filled' })
  assert.equal(filled.items.every((d) => d.filled), true)
  assert.equal(filled.gaps.length, 0)

  const empty = store.documentOverview({ projectId: p1.id, fill: 'empty' })
  assert.equal(empty.items.every((d) => !d.filled), true)
  assert.ok(empty.gaps.length > 0)
  tmp.cleanup()
})

test('document overview：非法 fill 拒绝，空项目范围返回空态', async () => {
  const { tmp, store, p1 } = await setup()
  assert.throws(() => store.documentOverview({ projectId: p1.id, fill: 'bogus' }), /VALIDATION_FAILED/)
  const out = store.documentOverview({ projectId: 999999 })
  assert.equal(out.summary.requirementCount, 0)
  assert.equal(out.summary.gapRequirementCount, 0)
  assert.deepEqual(out.items, [])
  assert.deepEqual(out.gaps, [])
  tmp.cleanup()
})

test('document overview：纯读聚合不产生 revision', async () => {
  const { tmp, store, p1, a } = await setup()
  store.upsertDocument(a.id, '需求内容', '正文')
  const before = store.getRevision()
  store.documentOverview({ projectId: p1.id, q: '正文' })
  assert.equal(store.getRevision(), before)
  tmp.cleanup()
})

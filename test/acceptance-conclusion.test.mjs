import test from 'node:test'
import assert from 'node:assert/strict'
import { tempHome } from './helpers.mjs'

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  return { tmp, store, p, r, s }
}

/** 需求文档 + 概要设计 + 一条回归用例，使文档门禁全过 */
function makeDocsReady(store, nodeId) {
  store.upsertDocument(nodeId, '需求内容', '需求正文')
  store.upsertDocument(nodeId, '概要设计', '设计正文')
  return store.upsertTestCase(nodeId, { name: '回归用例', prompt: '跑单测' })
}

function passReport(store, nodeId, caseId) {
  const rep = store.createTestReport(nodeId, { caseId, kind: 'regression', status: 'running' })
  store.finishTestReport(rep.id, { status: 'pass', summary: '全绿' })
}

test('acceptance_conclusion：无任何证据时 decision=unknown、ready=null', async (t) => {
  const { tmp, store, p } = await setup()
  t.after(() => tmp.cleanup())
  const out = store.buildAcceptanceConclusion(p.id)
  assert.equal(out.decision, 'unknown')
  assert.equal(out.ready, null)
  assert.equal(out.totals.units, 0)
  assert.deepEqual(out.blockers, [])
})

test('acceptance_conclusion：文档已就绪但测试未跑 → 该需求 fail，原因是测试未过', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  makeDocsReady(store, r.id)
  const out = store.buildAcceptanceConclusion(r.id)
  assert.equal(out.decision, 'rejected')
  assert.equal(out.ready, false)
  const item = out.items.find((i) => i.nodeId === r.id)
  assert.equal(item.decision, 'fail')
  assert.equal(item.caseBlockers[0].latestStatus, 'not_run')
  assert.equal(item.docBlockers.length, 0)
})

test('acceptance_conclusion：测试通过但文档缺概要设计 → 该需求 fail，原因是文档缺口', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  // 故意不写概要设计
  passReport(store, r.id, c.id)
  const out = store.buildAcceptanceConclusion(r.id)
  const item = out.items.find((i) => i.nodeId === r.id)
  assert.equal(item.decision, 'fail')
  assert.equal(item.caseBlockers.length, 0)
  assert.deepEqual(item.docBlockers.map((d) => d.key), ['design_doc'])
  assert.equal(out.decision, 'rejected')
})

test('acceptance_conclusion：测试与文档都齐 → pass / accepted', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const c = makeDocsReady(store, r.id)
  passReport(store, r.id, c.id)
  const out = store.buildAcceptanceConclusion(r.id)
  assert.equal(out.decision, 'accepted')
  assert.equal(out.ready, true)
  assert.equal(out.totals.pass, 1)
  assert.equal(out.totals.fail, 0)
  assert.deepEqual(out.blockers, [])
})

test('acceptance_conclusion：按版本过滤只判定匹配需求；过滤后无需求 → unknown', async (t) => {
  const { tmp, store, p, r, s } = await setup()
  t.after(() => tmp.cleanup())
  // version 作为普通属性定义登记在需求两层上（与「按版本生成验收结论」同口径）
  store.addAttrDef({ nodeType: 'requirement', key: 'version', label: '版本', dataType: 'text' })
  store.addAttrDef({ nodeType: 'subreq', key: 'version', label: '版本', dataType: 'text' })
  const rc = makeDocsReady(store, r.id)
  passReport(store, r.id, rc.id)
  const sc = makeDocsReady(store, s.id)
  passReport(store, s.id, sc.id)
  store.setAttrs(r.id, { version: '26Q3' })
  store.setAttrs(s.id, { version: '26Q4' })

  const v3 = store.buildAcceptanceConclusion(p.id, { scope: 'subtree', version: '26Q3' })
  assert.equal(v3.version, '26Q3')
  assert.deepEqual(v3.items.map((i) => i.nodeId), [r.id])
  assert.equal(v3.decision, 'accepted')

  const vNone = store.buildAcceptanceConclusion(p.id, { scope: 'subtree', version: '不存在的版本' })
  assert.equal(vNone.totals.units, 0)
  assert.equal(vNone.decision, 'unknown')
  assert.equal(vNone.ready, null)
})

test('acceptance_conclusion：scope 联动（self 不含子需求，subtree 含）', async (t) => {
  const { tmp, store, r, s } = await setup()
  t.after(() => tmp.cleanup())
  const rc = makeDocsReady(store, r.id)
  passReport(store, r.id, rc.id)
  const sc = makeDocsReady(store, s.id)
  passReport(store, s.id, sc.id)
  assert.equal(store.buildAcceptanceConclusion(r.id).totals.units, 1)
  assert.equal(store.buildAcceptanceConclusion(r.id, { scope: 'subtree' }).totals.units, 2)
})

test('acceptance_conclusion：纯读不产生 revision', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const c = makeDocsReady(store, r.id)
  passReport(store, r.id, c.id)
  const before = store.getRevision()
  store.buildAcceptanceConclusion(r.id)
  store.buildAcceptanceConclusion(r.id, { scope: 'subtree' })
  assert.equal(store.getRevision(), before)
})

test('acceptance_conclusion：非法 scope 拒绝（不静默降级）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(() => store.buildAcceptanceConclusion(r.id, { scope: 'sub' }), /VALIDATION_FAILED/)
})

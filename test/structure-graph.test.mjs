import test from 'node:test'
import assert from 'node:assert/strict'
import { tempHome } from './helpers.mjs'

async function setup() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  const task = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  return { tmp, store, p, r, s, task }
}

/** 让需求门禁全过：需求内容 + 概要设计 + 一条启用中回归用例 */
function makeReady(store, nodeId) {
  store.upsertDocument(nodeId, '需求内容', '需求正文')
  store.upsertDocument(nodeId, '概要设计', '设计正文')
  return store.createTestCase(nodeId, { name: '回归用例', prompt: '跑单测' })
}

test('structure_graph：树 + 状态叠加，self 只看本节点、subtree 含整棵子树', async (t) => {
  const { tmp, store, p, r, s } = await setup()
  t.after(() => tmp.cleanup())
  makeReady(store, r.id)
  const self = store.buildStructureGraph(r.id, { scope: 'self' })
  assert.equal(self.totals.nodes, 1)
  assert.equal(self.totals.edges, 0)
  const sub = store.buildStructureGraph(p.id, { scope: 'subtree' })
  assert.equal(sub.totals.nodes, 4)
  assert.equal(sub.totals.edges, 3)
  // depth 从根 0 递增
  assert.deepEqual(sub.nodes.map((n) => n.depth), [0, 1, 2, 3])
  assert.deepEqual(sub.nodes.map((n) => n.name), ['P', 'R', 'S', 'T'])
  assert.ok(s.id && s)
})

test('structure_graph：文档缺口 / 用例最近结论 / 就绪状态叠加正确', async (t) => {
  const { tmp, store, p, s } = await setup()
  t.after(() => tmp.cleanup())
  // P/R 子树：R 由 makeReady 补齐文档与回归用例；S 无文档 → 缺口 + 未就绪
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R2' })
  const c = makeReady(store, r.id)
  store.createTestReport(r.id, { caseId: c.id, kind: 'regression', status: 'running' })
  const out = store.buildStructureGraph(p.id, { scope: 'subtree' })
  const nodeR = out.nodes.find((n) => n.nodeId === r.id || n.id === r.id)
  assert.equal(nodeR.hasGap, false)
  assert.equal(nodeR.caseCount, 1)
  assert.equal(nodeR.caseRunning, 1)
  assert.equal(nodeR.caseStatus, 'running')
  // 就绪门禁只要求「文档齐 + 有可回归用例」，用例是否通过属于验收口径 → R 就绪
  assert.equal(nodeR.ready, true)
  // S 无文档 → 缺口 + 未就绪
  const nodeS = out.nodes.find((n) => n.id === s.id)
  assert.equal(nodeS.hasGap, true)
  assert.deepEqual(nodeS.documentGaps.map((g) => g.name).sort(), ['概要设计', '需求内容'])
  assert.equal(nodeS.ready, false)
})

test('structure_graph：用例状态按最严重优先（fail > running > not_run > pass）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const passCase = store.createTestCase(r.id, { name: 'pass 用例', prompt: 'p' })
  const passRep = store.createTestReport(r.id, { caseId: passCase.id, kind: 'regression', status: 'running' })
  store.finishTestReport(passRep.id, { status: 'pass' })
  // 只有 pass → pass
  assert.equal(store.buildStructureGraph(r.id).nodes[0].caseStatus, 'pass')
  // 加 running → running 更严重
  const runCase = store.createTestCase(r.id, { name: 'running 用例', prompt: 'p' })
  const runRep = store.createTestReport(r.id, { caseId: runCase.id, kind: 'regression', status: 'running' })
  assert.equal(store.buildStructureGraph(r.id).nodes[0].caseStatus, 'running')
  // 加 fail → fail 最严重
  store.finishTestReport(runRep.id, { status: 'fail' })
  assert.equal(store.buildStructureGraph(r.id).nodes[0].caseStatus, 'fail')
})

test('structure_graph：基础筛选（type / status / ready / hasGap / caseStatus / q）', async (t) => {
  const { tmp, store, p, r, s, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = makeReady(store, r.id)
  store.upsertDocument(s.id, '需求内容', '子需求正文') // S 缺概要设计 → hasGap
  void task

  const all = store.buildStructureGraph(p.id, { scope: 'subtree' })
  assert.equal(all.totals.nodes, 4)

  // type 筛选
  const byType = store.buildStructureGraph(p.id, { scope: 'subtree', type: 'subreq' })
  assert.deepEqual(byType.nodes.map((n) => n.name), ['S'])
  // hasGap=true 只留缺口节点（S 缺概要设计；R 已补齐无缺口）
  const gaps = store.buildStructureGraph(p.id, { scope: 'subtree', hasGap: true })
  assert.deepEqual(new Set(gaps.nodes.map((n) => n.name)), new Set(['S']))
  // hasGap=false 去掉缺口节点
  const noGap = store.buildStructureGraph(p.id, { scope: 'subtree', hasGap: false })
  assert.equal(noGap.nodes.some((n) => n.name === 'S'), false)
  // ready=false 含未就绪需求
  const notReady = store.buildStructureGraph(p.id, { scope: 'subtree', ready: false })
  assert.ok(notReady.nodes.some((n) => n.name === 'S'))
  // caseStatus=not_run（R 有用例未跑）
  const notRun = store.buildStructureGraph(p.id, { scope: 'subtree', caseStatus: 'not_run' })
  assert.deepEqual(notRun.nodes.map((n) => n.name), ['R'])
  // q 关键词
  const byQ = store.buildStructureGraph(p.id, { scope: 'subtree', q: 't' })
  assert.deepEqual(byQ.nodes.map((n) => n.name), ['T'])

  // 筛选只影响展示：边必须两端都在，根总在范围内
  for (const out of [byType, gaps, noGap, notRun, byQ]) {
    const kept = new Set(out.nodes.map((n) => n.id))
    assert.equal(out.edges.every((e) => kept.has(e.from) && kept.has(e.to)), true)
    assert.equal(out.totals.nodes, out.nodes.length)
    assert.equal(out.totals.total, 4)
  }
  void c
})

test('structure_graph：非法筛选值一律 VALIDATION_FAILED（不静默降级）', async (t) => {
  const { tmp, store, p } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(() => store.buildStructureGraph(p.id, { scope: 'sub' }), /VALIDATION_FAILED/)
  assert.throws(() => store.buildStructureGraph(p.id, { type: 'bogus' }), /VALIDATION_FAILED/)
  assert.throws(() => store.buildStructureGraph(p.id, { status: 'bogus' }), /VALIDATION_FAILED/)
  assert.throws(() => store.buildStructureGraph(p.id, { ready: 'maybe' }), /VALIDATION_FAILED/)
  assert.throws(() => store.buildStructureGraph(p.id, { hasGap: 'maybe' }), /VALIDATION_FAILED/)
  assert.throws(() => store.buildStructureGraph(p.id, { caseStatus: 'bogus' }), /VALIDATION_FAILED/)
})

test('structure_graph：纯读聚合，不产生 revision', async (t) => {
  const { tmp, store, p, r } = await setup()
  t.after(() => tmp.cleanup())
  makeReady(store, r.id)
  const before = store.getRevision()
  store.buildStructureGraph(p.id, { scope: 'subtree' })
  store.buildStructureGraph(p.id, { scope: 'subtree', hasGap: true, caseStatus: 'not_run' })
  assert.equal(store.getRevision(), before)
})

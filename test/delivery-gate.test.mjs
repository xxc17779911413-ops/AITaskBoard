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

const sourceOf = (gate, key) => gate.sources.find((s) => s.key === key)

/** 把需求补到「可进入测试」：需求内容 + 概要设计 + 一条启用中的回归用例 */
function makeReadinessPass(store, nodeId) {
  store.upsertDocument(nodeId, '需求内容', '需求正文')
  store.upsertDocument(nodeId, '概要设计', '设计正文')
  return store.upsertTestCase(nodeId, { name: '回归用例', prompt: '跑单测' })
}

/** 给用例写入一条 pass 报告，模拟测试验收已有终态结论 */
function makeAcceptancePass(store, nodeId, caseId) {
  const report = store.createTestReport(nodeId, { caseId, status: 'running', kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass', summary: '全绿' })
  store.upsertAcceptanceSignoff(nodeId, { decision: 'accepted', comment: '验收通过' })
}

test('delivery_gate：没有任何证据时返回 unknown（不伪造成可交付）', async (t) => {
  const { tmp, store, p } = await setup()
  t.after(() => tmp.cleanup())
  const gate = store.buildDeliveryGate(p.id)
  assert.equal(gate.decision, 'unknown')
  assert.equal(gate.ready, null)
  assert.equal(gate.totals.applicable, 0)
  assert.equal(gate.totals.notApplicable, 3)
  assert.deepEqual(gate.blockers, [])
  assert.equal(sourceOf(gate, 'readiness').status, 'not_applicable')
  assert.equal(sourceOf(gate, 'acceptance').status, 'not_applicable')
  assert.equal(sourceOf(gate, 'release').status, 'not_applicable')
})

test('delivery_gate：需求已就绪但测试尚未执行时不可交付', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const testCase = makeReadinessPass(store, r.id)
  const gate = store.buildDeliveryGate(r.id)
  assert.equal(gate.decision, 'not_ready')
  assert.equal(sourceOf(gate, 'readiness').status, 'pass')
  assert.equal(sourceOf(gate, 'acceptance').status, 'fail')
  assert.equal(sourceOf(gate, 'release').status, 'not_applicable')
  assert.equal(sourceOf(gate, 'acceptance').evidence.totals.notRun, 1)
  assert.equal(sourceOf(gate, 'acceptance').evidence.items[0].latestStatus, 'not_run')
  assert.equal(gate.blockers.length, 1)
  assert.equal(gate.blockers[0].name, testCase.name)
  assert.equal(gate.blockers[0].detail, '最近结果：not_run')
})

test('delivery_gate：running 也明确阻塞交付，并带 blocker 明细', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const testCase = makeReadinessPass(store, r.id)
  store.createTestReport(r.id, { caseId: testCase.id, status: 'running', kind: 'regression' })
  const gate = store.buildDeliveryGate(r.id)
  assert.equal(gate.decision, 'not_ready')
  assert.equal(sourceOf(gate, 'acceptance').status, 'fail')
  assert.equal(sourceOf(gate, 'acceptance').evidence.totals.running, 1)
  assert.equal(sourceOf(gate, 'acceptance').evidence.items[0].latestStatus, 'running')
  assert.deepEqual(gate.blockers.map((b) => [b.source, b.name, b.detail]), [['acceptance', testCase.name, '最近结果：running']])
})

test('acceptance / delivery_gate：停用用例不参与门禁，与 readiness 口径一致', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const testCase = makeReadinessPass(store, r.id)
  const disabled = store.createTestCase(r.id, { name: '已停用用例', prompt: 'p', enabled: 0 })
  makeAcceptancePass(store, r.id, testCase.id)

  const acceptance = store.buildAcceptanceReport(r.id)
  assert.equal(acceptance.totals.cases, 1)
  assert.equal(acceptance.totals.notRun, 0)
  assert.ok(!acceptance.items.some((i) => i.caseId === disabled.id))
  assert.equal(store.buildDeliveryGate(r.id).decision, 'ready')
})

test('delivery_gate：三段全部通过才可交付；不适用项不阻塞', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const testCase = makeReadinessPass(store, r.id)
  makeAcceptancePass(store, r.id, testCase.id)
  store.createReleaseItem(r.id, { name: '仅可选监控', kind: 'check', required: 0 })

  const gate = store.buildDeliveryGate(r.id)
  assert.equal(gate.decision, 'ready')
  assert.equal(gate.ready, true)
  assert.equal(gate.totals.passed, 2)
  assert.equal(gate.totals.notApplicable, 1)
  assert.deepEqual(gate.blockers, [])
})

test('delivery_gate：必做上线项未完成时覆盖测试通过结论，返回 not_ready', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const testCase = makeReadinessPass(store, r.id)
  makeAcceptancePass(store, r.id, testCase.id)
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'pending' })

  const gate = store.buildDeliveryGate(r.id)
  assert.equal(gate.decision, 'not_ready')
  assert.equal(sourceOf(gate, 'release').status, 'fail')
  assert.equal(gate.blockers.length, 1)
  assert.equal(gate.blockers[0].source, 'release')
  assert.equal(gate.blockers[0].name, '执行上线 SQL')
})

test('delivery_gate：scope=subtree 纳入子树需求与上线项', async (t) => {
  const { tmp, store, p, r, s } = await setup()
  t.after(() => tmp.cleanup())
  makeReadinessPass(store, r.id)
  const sCase = store.upsertTestCase(s.id, { name: '子需求回归', prompt: '跑子需求单测' })
  store.upsertDocument(s.id, '需求内容', '子需求正文')

  const gate = store.buildDeliveryGate(p.id, { scope: 'subtree' })
  assert.equal(gate.decision, 'not_ready')
  assert.equal(sourceOf(gate, 'readiness').status, 'fail')
  assert.equal(sourceOf(gate, 'readiness').evidence.totals.units, 2)
  assert.ok(gate.blockers.some((b) => b.name.includes('S')))
  assert.ok(sCase.id > 0)
})

test('delivery_gate：纯读聚合，不产生 revision', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const testCase = makeReadinessPass(store, r.id)
  makeAcceptancePass(store, r.id, testCase.id)
  const before = store.getRevision()
  store.buildDeliveryGate(r.id)
  store.buildDeliveryGate(r.id, { scope: 'subtree' })
  assert.equal(store.getRevision(), before)
})

test('delivery_gate：必做上线项已 done 但检查用例未执行时仍不可交付（假绿灯回归）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const testCase = makeReadinessPass(store, r.id)
  makeAcceptancePass(store, r.id, testCase.id)
  // 上线项全部完成，但登记在册的代码检查从未执行：旧实现会给出 ready
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'done' })
  const lint = store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })

  const gate = store.buildDeliveryGate(r.id)
  assert.equal(gate.decision, 'not_ready')
  assert.equal(sourceOf(gate, 'release').status, 'fail')
  assert.ok(gate.blockers.some((b) => b.source === 'release' && b.name === lint.name))

  // 检查用例回写 pass 后才恢复可交付
  const report = store.createTestReport(r.id, { caseId: lint.id, kind: 'code_check', status: 'running' })
  store.finishTestReport(report.id, { status: 'pass', summary: '无告警' })
  const after = store.buildDeliveryGate(r.id)
  assert.equal(after.decision, 'ready')
  assert.equal(sourceOf(after, 'release').status, 'pass')
})

test('delivery_gate：markdown 渲染含最终结论与阻塞项', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  makeReadinessPass(store, r.id)
  const { renderDeliveryGateMd } = await import('../server/ops.mjs')
  const md = renderDeliveryGateMd(store.buildDeliveryGate(r.id))
  assert.match(md, /^# 交付门禁：R/m)
  assert.match(md, /不可交付/)
  assert.match(md, /## 阻塞项/)
  assert.match(md, /回归用例/)
})

test('delivery_gate：markdown 表格转义 | 与换行，避免撑破列', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  makeReadinessPass(store, r.id)
  const tricky = store.createTestCase(r.id, { name: '用例|含竖线\n换行', prompt: 'p', enabled: 1 })
  const gate = store.buildDeliveryGate(r.id)
  const { renderDeliveryGateMd } = await import('../server/ops.mjs')
  const md = renderDeliveryGateMd(gate)
  assert.ok(tricky.id > 0)
  assert.ok(md.includes('用例\\|含竖线 换行'))
  const row = md.split('\n').find((line) => line.includes('用例\\|含竖线'))
  assert.ok(row.endsWith(' |'))
  assert.ok(!row.includes('用例|含竖线'))
})

test('delivery_gate：markdown 转义输入自带的反斜杠（先 \\\\ 再 |）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  makeReadinessPass(store, r.id)
  store.createTestCase(r.id, { name: 'a\\|b', prompt: 'p', enabled: 1 })
  const { renderDeliveryGateMd } = await import('../server/ops.mjs')
  const md = renderDeliveryGateMd(store.buildDeliveryGate(r.id))
  const row = md.split('\n').find((line) => line.includes('a'))
  assert.ok(row)
  // 字面 a\|b 必须变成 a\\\|b：反斜杠先被翻倍，竖线再被转义
  assert.ok(row.includes('a\\\\\\|b'))
})

test('format：缺省/合法值通过，非法值 VALIDATION_FAILED', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  assert.equal(store.normalizeFormat(undefined), 'json')
  assert.equal(store.normalizeFormat(null), 'json')
  assert.equal(store.normalizeFormat('json'), 'json')
  assert.equal(store.normalizeFormat('md'), 'md')
  for (const bad of ['xml', 'markdown', '', ' ']) {
    assert.throws(() => store.normalizeFormat(bad), /VALIDATION_FAILED/)
  }
})

test('delivery_gate：登记进能力清单（MCP / CLI / REST 1:1 的发现入口）', async () => {
  const { TOOLS } = await import('../server/ops.mjs')
  assert.ok(TOOLS.includes('delivery_gate'))
})

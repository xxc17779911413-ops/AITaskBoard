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
  const g = store.createNode({ parentId: s.id, type: 'group', name: 'G' })
  const t = store.createNode({ parentId: g.id, type: 'task', name: 'T' })
  return { tmp, store, p, r, s, g, t }
}

/** 给一条用例开出并完结一条报告 */
function runCase(store, nodeId, caseId, status) {
  const rep = store.createTestReport(nodeId, { caseId, kind: 'biz_check' })
  return store.finishTestReport(rep.id, { status })
}

test('business_gate：范围内没有缺陷与业务检查用例时 ready=null（不伪造成通过）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const gate = store.buildBusinessGate(r.id)
  assert.equal(gate.ready, null)
  assert.equal(gate.totals.defects, 0)
  assert.equal(gate.totals.cases, 0)
  assert.deepEqual(gate.blockers, [])
})

test('business_gate：未关闭缺陷阻塞，缺陷关闭后放行', async (t) => {
  const { tmp, store, r, g } = await setup()
  t.after(() => tmp.cleanup())
  const d = store.createNode({ parentId: g.id, type: 'defect', name: 'D' })
  let gate = store.buildBusinessGate(r.id, { scope: 'subtree' })
  assert.equal(gate.ready, false)
  assert.equal(gate.totals.openDefects, 1)
  assert.equal(gate.blockers[0].kind, 'open_defect')
  assert.equal(gate.blockers[0].name, 'D')

  store.updateNode(d.id, { status: 'done' })
  gate = store.buildBusinessGate(r.id, { scope: 'subtree' })
  assert.equal(gate.ready, true)
  assert.equal(gate.totals.closedDefects, 1)
  assert.deepEqual(gate.blockers, [])
})

test('business_gate：cancelled 缺陷也算关闭，doing / todo 都阻塞', async (t) => {
  const { tmp, store, r, g } = await setup()
  t.after(() => tmp.cleanup())
  const a = store.createNode({ parentId: g.id, type: 'defect', name: 'A' })
  const b = store.createNode({ parentId: g.id, type: 'defect', name: 'B' })
  store.updateNode(a.id, { status: 'cancelled' })
  store.updateNode(b.id, { status: 'doing' })
  const gate = store.buildBusinessGate(r.id, { scope: 'subtree' })
  assert.equal(gate.totals.defects, 2)
  assert.equal(gate.totals.openDefects, 1)
  assert.equal(gate.ready, false)
  assert.deepEqual(gate.blockers.map((x) => x.name), ['B'])
})

test('business_gate：业务检查用例只有最近一次 pass 才放行', async (t) => {
  const { tmp, store, s } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(s.id, { name: '下单主流程', prompt: 'p', kind: 'biz_check' })

  // 从未执行 → not_run，阻塞
  let gate = store.buildBusinessGate(s.id)
  assert.equal(gate.ready, false)
  assert.equal(gate.cases[0].latestStatus, 'not_run')
  assert.equal(gate.cases[0].latestReportId, null)

  // 已派单未回写 → running，仍阻塞
  const running = store.createTestReport(s.id, { caseId: c.id, kind: 'biz_check' })
  gate = store.buildBusinessGate(s.id)
  assert.equal(gate.cases[0].latestStatus, 'running')
  assert.equal(gate.ready, false)

  // 最近一次 fail → 阻塞
  store.finishTestReport(running.id, { status: 'fail' })
  gate = store.buildBusinessGate(s.id)
  assert.equal(gate.ready, false)
  assert.equal(gate.blockers[0].latestStatus, 'fail')

  // 重新跑通：只有最近一次是 pass 才算通过（历史 fail 不覆盖新一轮 pass）
  runCase(store, s.id, c.id, 'pass')
  gate = store.buildBusinessGate(s.id)
  assert.equal(gate.cases[0].latestStatus, 'pass')
  assert.equal(gate.ready, true)
})

test('business_gate：历史 pass 不掩盖后来的 fail（只认最近一次）', async (t) => {
  const { tmp, store, s } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(s.id, { name: 'C', prompt: 'p', kind: 'biz_check' })
  runCase(store, s.id, c.id, 'pass')
  assert.equal(store.buildBusinessGate(s.id).ready, true)
  runCase(store, s.id, c.id, 'fail')
  const gate = store.buildBusinessGate(s.id)
  assert.equal(gate.ready, false)
  assert.equal(gate.cases[0].latestStatus, 'fail')
})

test('business_gate：停用的业务检查用例不阻塞（既不会派单也不该拦住验收）', async (t) => {
  const { tmp, store, s } = await setup()
  t.after(() => tmp.cleanup())
  store.createTestCase(s.id, { name: '停用检查', prompt: 'p', kind: 'biz_check', enabled: 0 })
  const gate = store.buildBusinessGate(s.id)
  assert.equal(gate.totals.cases, 0)
  // 没有任何可判定对象（缺陷 / 启用用例）→ 空态
  assert.equal(gate.ready, null)
})

test('business_gate：其它 kind 的用例不参与业务门禁', async (t) => {
  const { tmp, store, s } = await setup()
  t.after(() => tmp.cleanup())
  store.createTestCase(s.id, { name: '回归', prompt: 'p', kind: 'regression' })
  store.createTestCase(s.id, { name: '代码检查', prompt: 'p', kind: 'code_check' })
  store.createTestCase(s.id, { name: '上线检查', prompt: 'p', kind: 'release_check' })
  const gate = store.buildBusinessGate(s.id)
  assert.equal(gate.totals.cases, 0)
  assert.equal(gate.ready, null)
})

test('business_gate：scope=self 只看本节点，subtree 纳入子树', async (t) => {
  const { tmp, store, r, s, g } = await setup()
  t.after(() => tmp.cleanup())
  store.createNode({ parentId: g.id, type: 'defect', name: 'D' })
  const c = store.createTestCase(s.id, { name: 'C', prompt: 'p', kind: 'biz_check' })
  runCase(store, s.id, c.id, 'pass')

  const self = store.buildBusinessGate(r.id)
  assert.equal(self.scope, 'self')
  assert.equal(self.totals.defects, 0)
  assert.equal(self.totals.cases, 0)
  assert.equal(self.ready, null)

  const subtree = store.buildBusinessGate(r.id, { scope: 'subtree' })
  assert.equal(subtree.totals.defects, 1)
  assert.equal(subtree.totals.cases, 1)
  assert.equal(subtree.ready, false)
})

test('business_gate：scope 非法值报 VALIDATION_FAILED，不静默降级', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(
    () => store.buildBusinessGate(r.id, { scope: 'Subtree' }),
    (e) => e.code === 'VALIDATION_FAILED'
  )
  assert.throws(
    () => store.buildBusinessGate(r.id, { scope: '' }),
    (e) => e.code === 'VALIDATION_FAILED'
  )
})

test('business_gate：纯读聚合不产生 revision', async (t) => {
  const { tmp, store, r, g } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(r.id, { name: 'C', prompt: 'p', kind: 'biz_check' })
  store.createNode({ parentId: g.id, type: 'defect', name: 'D' })
  const before = store.getRevision()
  store.buildBusinessGate(r.id, { scope: 'subtree' })
  store.buildBusinessGate(r.id)
  assert.equal(store.getRevision(), before)
  assert.ok(c.id)
})

test('renderBusinessGateMd：输出可读 markdown 并转义表格单元格', async (t) => {
  const { tmp, store, r, g } = await setup()
  t.after(() => tmp.cleanup())
  const { renderBusinessGateMd } = await import('../server/ops.mjs')
  store.createNode({ parentId: g.id, type: 'defect', name: 'a|b' })
  const c = store.createTestCase(r.id, { name: 'C', prompt: 'p', kind: 'biz_check' })
  runCase(store, r.id, c.id, 'fail')
  const md = renderBusinessGateMd(store.buildBusinessGate(r.id, { scope: 'subtree' }))
  assert.ok(md.startsWith('# 业务检查：R'))
  assert.ok(md.includes('尚不可验收'))
  assert.ok(md.includes('a\\|b'), '竖线必须转义，避免把表格切歪')
  assert.ok(md.includes('| C | fail |'))
})

// ---------- 回归：报告 kind 与用例 kind 不一致时的假绿（独立验收 D1） ----------

test('假绿回归：报告 kind 与用例 kind 不一致时被拒（写入侧一致性校验）', async (t) => {
  const { tmp, store, s } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(s.id, { name: '业务检查项', prompt: 'p', kind: 'biz_check' })
  // 原问题：createTestReport 只校验 caseId 同节点 / runId 存在，不校验 kind，
  // 于是一条 regression 报告能挂在 biz_check 用例上冒充业务检查结论。
  assert.throws(
    () => store.createTestReport(s.id, { caseId: c.id, kind: 'regression' }),
    (e) => e.code === 'VALIDATION_FAILED' && /不一致/.test(e.message)
  )
  // 与用例 kind 一致才放行
  const ok = store.createTestReport(s.id, { caseId: c.id, kind: 'biz_check' })
  assert.equal(ok.kind, 'biz_check')
  // 省略 kind 时直接沿用用例的 kind（不再默认 regression，避免「少传字段」踩进同一个坑）
  const derived = store.createTestReport(s.id, { caseId: c.id })
  assert.equal(derived.kind, 'biz_check')
  // 没有 caseId（临时跑一次 / 用例已删除）时才回落到默认 regression
  const loose = store.createTestReport(s.id, {})
  assert.equal(loose.kind, 'regression')
})

test('假绿回归：历史脏报告（kind 不一致）不得让业务检查门禁通过（读取侧收窄）', async (t) => {
  const { tmp, store, s } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(s.id, { name: '业务检查项', prompt: 'p', kind: 'biz_check' })
  // 绕过写入侧校验，直接落一条 kind 不一致的 pass 报告，模拟老库里的历史脏数据
  store.db
    .prepare(
      'INSERT INTO test_reports (node_id,case_id,run_id,kind,status,summary,detail,started_at,finished_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(s.id, c.id, null, 'regression', 'pass', 'stale', null, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), 'user')

  const gate = store.buildBusinessGate(s.id)
  // 不一致的报告被忽略 → 该用例回到 not_run → 阻塞，不再是假绿
  assert.equal(gate.cases[0].latestStatus, 'not_run')
  assert.equal(gate.cases[0].latestReportId, null)
  assert.equal(gate.ready, false)
  assert.equal(gate.blockers[0].kind, 'unpassed_case')
})

test('假绿回归：验收报告同样不采纳跨 kind 报告（读取侧口径一致）', async (t) => {
  const { tmp, store, s } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(s.id, { name: '业务检查项', prompt: 'p', kind: 'biz_check' })
  store.db
    .prepare(
      'INSERT INTO test_reports (node_id,case_id,run_id,kind,status,summary,detail,started_at,finished_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(s.id, c.id, null, 'regression', 'pass', 'stale', null, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), 'user')
  const acc = store.buildAcceptanceReport(s.id)
  assert.equal(acc.items[0].latestStatus, 'not_run')
  assert.equal(acc.totals.pass, 0)
  assert.equal(acc.totals.notRun, 1)
})

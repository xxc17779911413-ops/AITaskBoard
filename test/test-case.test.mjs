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
  const task = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  return { tmp, store, p, r, s, task }
}

// ---------- test_cases ----------

test('test_case：创建 / 列表 / 默认类型 regression', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: '登录回归', prompt: '跑登录单测', expectation: '全绿' })
  assert.ok(c.id > 0)
  assert.equal(c.kind, 'regression')
  assert.equal(c.enabled, true)
  assert.equal(c.expectation, '全绿')
  assert.equal(store.listTestCases(task.id).length, 1)
})

test('test_case：名称在同节点内唯一，重名报 TEST_CASE_NAME_EXISTS', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  assert.throws(() => store.createTestCase(task.id, { name: 'A', prompt: 'q' }), /TEST_CASE_NAME_EXISTS/)
  const b = store.createTestCase(task.id, { name: 'B', prompt: 'p' })
  assert.throws(() => store.updateTestCase(b.id, { name: 'A' }), /TEST_CASE_NAME_EXISTS/)
})

test('test_case：名称与 prompt 必填，非法 kind 拒绝', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(() => store.createTestCase(task.id, { name: '  ', prompt: 'p' }), /测试用例名必填/)
  assert.throws(() => store.createTestCase(task.id, { name: 'X', prompt: '  ' }), /必填/)
  assert.throws(() => store.createTestCase(task.id, { name: 'X', prompt: 'p', kind: 'bogus' }), /未知测试类型/)
})

test('test_case：upsert 按名幂等并覆盖，created 标记正确', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const first = store.upsertTestCase(task.id, { name: '回归', prompt: 'v1', expectation: 'e1' })
  assert.equal(first.created, true)
  const second = store.upsertTestCase(task.id, { name: '回归', prompt: 'v2', expectation: 'e2' })
  assert.equal(second.created, false)
  assert.equal(second.id, first.id)
  const list = store.listTestCases(task.id)
  assert.equal(list.length, 1)
  assert.equal(list[0].prompt, 'v2')
  assert.equal(list[0].expectation, 'e2')
})

test('test_case：kind 筛选与 includeDisabled', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  store.createTestCase(task.id, { name: 'R1', prompt: 'p', kind: 'regression' })
  store.createTestCase(task.id, { name: 'A1', prompt: 'p', kind: 'acceptance' })
  const off = store.createTestCase(task.id, { name: 'C1', prompt: 'p', kind: 'code_check', enabled: 0 })
  assert.equal(store.listTestCases(task.id).length, 2)
  assert.equal(store.listTestCases(task.id, { kind: 'acceptance' }).length, 1)
  assert.equal(store.listTestCases(task.id, { includeDisabled: true }).length, 3)
  assert.equal(off.enabled, false)
})

test('test_case：排序与删除', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const a = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const b = store.createTestCase(task.id, { name: 'B', prompt: 'p' })
  const c = store.createTestCase(task.id, { name: 'C', prompt: 'p' })
  store.reorderTestCases(task.id, [c.id, a.id, b.id])
  assert.deepEqual(store.listTestCases(task.id).map((x) => x.name), ['C', 'A', 'B'])
  store.deleteTestCase(b.id)
  assert.deepEqual(store.listTestCases(task.id).map((x) => x.name), ['C', 'A'])
})

test('test_case：随节点级联删除', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const taskId = task.id
  store.deleteNode(task.id)
  // 节点已删，listTestCases 会因节点不存在而报错；直接查库确认级联清空
  const left = store.db.prepare('SELECT COUNT(*) c FROM test_cases WHERE node_id = ?').get(taskId).c
  assert.equal(left, 0)
})

// ---------- test_reports ----------

test('test_report：开报告默认 running，finish 回写终态', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const rep = store.createTestReport(task.id, { caseId: c.id, kind: 'regression' })
  assert.equal(rep.status, 'running')
  assert.equal(rep.runId, null)
  assert.equal(rep.finishedAt, null)
  const done = store.finishTestReport(rep.id, { status: 'pass', summary: '全绿' })
  assert.equal(done.status, 'pass')
  assert.ok(done.finishedAt)
  assert.equal(done.summary, '全绿')
})

test('test_report：列表倒序 + 按 caseId / kind 筛', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c1 = store.createTestCase(task.id, { name: 'A', prompt: 'p', kind: 'regression' })
  const c2 = store.createTestCase(task.id, { name: 'B', prompt: 'p', kind: 'acceptance' })
  store.createTestReport(task.id, { caseId: c1.id, kind: 'regression' })
  store.createTestReport(task.id, { caseId: c2.id, kind: 'acceptance' })
  const all = store.listTestReports(task.id)
  assert.equal(all.length, 2)
  assert.ok(all[0].id > all[1].id)
  assert.equal(store.listTestReports(task.id, { caseId: c1.id }).length, 1)
  assert.equal(store.listTestReports(task.id, { kind: 'acceptance' }).length, 1)
})

test('test_report：删除用例后历史报告保留，caseId 置空', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const rep = store.createTestReport(task.id, { caseId: c.id, kind: 'regression' })
  store.deleteTestCase(c.id)
  const kept = store.getTestReport(rep.id)
  assert.equal(kept.caseId, null)
})

// ---------- acceptance report ----------

test('acceptance：聚合最近结果与通过率（已完结口径，分桶守恒）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const a = store.createTestCase(task.id, { name: 'A', prompt: 'p', expectation: 'e' })
  const b = store.createTestCase(task.id, { name: 'B', prompt: 'p' })
  const c = store.createTestCase(task.id, { name: 'C', prompt: 'p' })
  // A 先失败后通过（应取最近一次），B 失败，C 未执行
  const ra1 = store.createTestReport(task.id, { caseId: a.id, kind: 'regression' })
  store.finishTestReport(ra1.id, { status: 'fail' })
  const ra2 = store.createTestReport(task.id, { caseId: a.id, kind: 'regression' })
  store.finishTestReport(ra2.id, { status: 'pass' })
  const rb = store.createTestReport(task.id, { caseId: b.id, kind: 'regression' })
  store.finishTestReport(rb.id, { status: 'fail' })

  const report = store.buildAcceptanceReport(task.id)
  assert.equal(report.totals.cases, 3)
  assert.equal(report.totals.settled, 2)
  assert.equal(report.totals.pass, 1)
  assert.equal(report.totals.fail, 1)
  assert.equal(report.totals.running, 0)
  assert.equal(report.totals.notRun, 1)
  assert.equal(
    report.totals.pass + report.totals.fail + report.totals.blocked + report.totals.error +
      report.totals.cancelled + report.totals.running + report.totals.notRun,
    report.totals.cases
  )
  assert.equal(report.passRate, 0.5)
  const itemA = report.items.find((i) => i.caseId === a.id)
  assert.equal(itemA.latestStatus, 'pass')
  const itemC = report.items.find((i) => i.caseId === c.id)
  assert.equal(itemC.latestStatus, 'not_run')
})

test('acceptance：scope=subtree 覆盖子树用例', async (t) => {
  const { tmp, store, s, task } = await setup()
  t.after(() => tmp.cleanup())
  store.createTestCase(task.id, { name: 'T1', prompt: 'p' })
  store.createTestCase(s.id, { name: 'S1', prompt: 'p' })
  assert.equal(store.buildAcceptanceReport(task.id).totals.cases, 1)
  assert.equal(store.buildAcceptanceReport(s.id, { scope: 'subtree' }).totals.cases, 2)
})

test('acceptance：无用例时 passRate 为 null', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const report = store.buildAcceptanceReport(task.id)
  assert.equal(report.totals.cases, 0)
  assert.equal(report.passRate, null)
})

// ---------- 编排层（至少覆盖 dryRun 与提示词拼装） ----------

test('runTestCases：无用例时报错', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  assert.throws(() => runTestCases(store, task.id, { dryRun: true }), /没有可执行的测试用例/)
})

test('runTestCases：dryRun 返回用例与提示词、不落库不派单', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: '跑 A', expectation: '绿' })
  store.createTestCase(task.id, { name: 'B', prompt: '跑 B' })
  const out = runTestCases(store, task.id, { dryRun: true })
  assert.equal(out.dryRun, true)
  assert.equal(out.cases.length, 2)
  assert.ok(out.prompt.includes('用例 1：A'))
  assert.ok(out.prompt.includes('期望结果：绿'))
  assert.ok(out.prompt.includes('PASS|FAIL|BLOCKED'))
  assert.equal(store.listTestReports(task.id).length, 0)
})

test('runTestCases：dryRun 按 kind / caseIds 过滤', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  const r = store.createTestCase(task.id, { name: 'R', prompt: 'p', kind: 'regression' })
  store.createTestCase(task.id, { name: 'A', prompt: 'p', kind: 'acceptance' })
  const byKind = runTestCases(store, task.id, { dryRun: true, kind: 'acceptance' })
  assert.deepEqual(byKind.cases.map((c) => c.name), ['A'])
  const byId = runTestCases(store, task.id, { dryRun: true, caseIds: [r.id] })
  assert.deepEqual(byId.cases.map((c) => c.name), ['R'])
})

test('renderAcceptanceMd：输出可读验收报告', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { renderAcceptanceMd } = await import('../server/ops.mjs')
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const rep = store.createTestReport(task.id, { caseId: c.id })
  store.finishTestReport(rep.id, { status: 'pass' })
  const md = renderAcceptanceMd(store.buildAcceptanceReport(task.id))
  assert.ok(md.startsWith('# 验收报告'))
  assert.ok(md.includes('| A |'))
  assert.ok(md.includes('100%'))
})

// ---------- 回归：验收退回的缺陷 2 / 3 / 4（每条都能复现原问题） ----------

test('缺陷2回归：非法 status 被应用层拦成 VALIDATION_FAILED，不泄漏 ERR_SQLITE_ERROR', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  // 原问题：createTestReport / finishTestReport 不校验 status，直接落 DB CHECK → ERR_SQLITE_ERROR
  assert.throws(
    () => store.createTestReport(task.id, { status: 'bogus' }),
    (e) => e.code === 'VALIDATION_FAILED' && !String(e.message).includes('SQLITE')
  )
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const rep = store.createTestReport(task.id, { caseId: c.id })
  assert.throws(
    () => store.finishTestReport(rep.id, { status: 'bogus' }),
    (e) => e.code === 'VALIDATION_FAILED' && !String(e.message).includes('SQLITE')
  )
})

test('缺陷2回归：running→终态单向；终态同状态幂等且不改 finished_at；终态互转默认拒绝', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const rep = store.createTestReport(task.id, { caseId: c.id })
  assert.equal(rep.status, 'running')
  assert.equal(rep.finishedAt, null)

  // running → 终态：允许
  const passed = store.finishTestReport(rep.id, { status: 'pass', summary: '第一次' })
  assert.equal(passed.status, 'pass')
  const firstFinishedAt = passed.finishedAt
  assert.ok(firstFinishedAt)

  // 终态 → 同状态：幂等（允许补摘要，finished_at 不变）
  const again = store.finishTestReport(rep.id, { status: 'pass', summary: '复跑仍全绿' })
  assert.equal(again.status, 'pass')
  assert.equal(again.summary, '复跑仍全绿')
  assert.equal(again.finishedAt, firstFinishedAt)

  // 终态 → 其它状态（含回退 running）：默认拒绝
  assert.throws(() => store.finishTestReport(rep.id, { status: 'fail' }), /REPORT_STATUS_IMMUTABLE/)
  assert.throws(() => store.finishTestReport(rep.id, { status: 'running' }), /REPORT_STATUS_IMMUTABLE/)

  // 显式 overwrite：允许纠正
  const corrected = store.finishTestReport(rep.id, { status: 'fail', overwrite: true, summary: '验收纠正' })
  assert.equal(corrected.status, 'fail')
  assert.equal(corrected.summary, '验收纠正')
})

test('缺陷3回归：验收分桶总数守恒，running 单列且不计入通过率分母', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  // 5 个用例分别处于 pass / fail / blocked / error / cancelled —— 原问题：cancelled 从明细消失、分桶不守恒
  const mk = (name, final) => {
    const c = store.createTestCase(task.id, { name, prompt: 'p' })
    const r = store.createTestReport(task.id, { caseId: c.id })
    store.finishTestReport(r.id, { status: final })
    return c
  }
  mk('A', 'pass')
  mk('B', 'fail')
  mk('C', 'blocked')
  mk('D', 'error')
  mk('E', 'cancelled')
  // 再加一个「已派单未回写」的 running 和一个未执行的
  const runningCase = store.createTestCase(task.id, { name: 'F', prompt: 'p' })
  store.createTestReport(task.id, { caseId: runningCase.id }) // 默认 running
  store.createTestCase(task.id, { name: 'G', prompt: 'p' })

  const report = store.buildAcceptanceReport(task.id)
  const t2 = report.totals
  assert.equal(t2.cases, 7)
  assert.equal(t2.pass, 1)
  assert.equal(t2.fail, 1)
  assert.equal(t2.blocked, 1)
  assert.equal(t2.error, 1)
  assert.equal(t2.cancelled, 1)
  assert.equal(t2.running, 1)
  assert.equal(t2.notRun, 1)
  // 总数守恒（原问题：pass+fail+blocked ≠ run）
  const sum = t2.pass + t2.fail + t2.blocked + t2.error + t2.cancelled + t2.running + t2.notRun
  assert.equal(sum, t2.cases)
  // 分母 = 五种终态之和，running / notRun 不计入
  assert.equal(t2.settled, 5)
  assert.equal(report.passRate, 0.2)
})

test('缺陷3回归：刚派单（全 running）时通过率为 null，而不是 0', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  store.createTestReport(task.id, { caseId: c.id }) // running
  const report = store.buildAcceptanceReport(task.id)
  assert.equal(report.totals.running, 1)
  assert.equal(report.totals.settled, 0)
  assert.equal(report.passRate, null)
})

test('缺陷4回归：报告的 caseId 必须属于同节点；runId 必须存在', async (t) => {
  const { tmp, store, s, task } = await setup()
  t.after(() => tmp.cleanup())
  // 原问题：跨节点的用例 id 被静默接受，破坏「用例-报告同节点」
  const otherCase = store.createTestCase(s.id, { name: '别的节点的用例', prompt: 'p' })
  assert.throws(
    () => store.createTestReport(task.id, { caseId: otherCase.id }),
    (e) => e.code === 'VALIDATION_FAILED' && /不属于节点/.test(e.message)
  )
  // 不存在的 runId：NOT_FOUND，而不是外键报 ERR_SQLITE_ERROR
  const mine = store.createTestCase(task.id, { name: '本节点用例', prompt: 'p' })
  assert.throws(
    () => store.createTestReport(task.id, { caseId: mine.id, runId: 999999 }),
    (e) => e.code === 'NOT_FOUND' && !String(e.message).includes('SQLITE')
  )
  // 本节点用例 + 合法（不传 runId）仍可开报告
  const ok = store.createTestReport(task.id, { caseId: mine.id })
  assert.equal(ok.caseId, mine.id)
})

test('缺陷回归：报告筛选在 LIMIT 之前生效，报告数 > limit 仍能筛到旧报告', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  // 旧用例 c1（报告会被后续 150 条挤出默认 limit=100 的窗口）
  const c1 = store.createTestCase(task.id, { name: '旧用例', prompt: 'p', kind: 'acceptance' })
  for (let i = 0; i < 5; i += 1) store.createTestReport(task.id, { caseId: c1.id, kind: 'acceptance' })
  // 新用例 c2 堆 150 条 regression 报告
  const c2 = store.createTestCase(task.id, { name: '新用例', prompt: 'p', kind: 'regression' })
  for (let i = 0; i < 150; i += 1) store.createTestReport(task.id, { caseId: c2.id, kind: 'regression' })

  // 未过滤时默认窗口就是最新 100 条
  assert.equal(store.listTestReports(task.id).length, 100)
  // 按 caseId 筛选：旧用例的 5 条必须能筛到（原问题：先 LIMIT 再内存过滤 → 空列表）
  const byCase = store.listTestReports(task.id, { caseId: c1.id })
  assert.equal(byCase.length, 5)
  assert.equal(byCase.every((r) => r.caseId === c1.id), true)
  // 按 kind 筛选：acceptance 也应筛到 5 条（旧类型同样被窗口挤出）
  const byKind = store.listTestReports(task.id, { kind: 'acceptance' })
  assert.equal(byKind.length, 5)
  assert.equal(byKind.every((r) => r.kind === 'acceptance'), true)
  // caseId + kind 叠加仍生效
  assert.equal(store.listTestReports(task.id, { caseId: c1.id, kind: 'acceptance' }).length, 5)
  // 显式 limit 作用于过滤后的结果：取最新 3 条
  const limited = store.listTestReports(task.id, { caseId: c1.id, limit: 3 })
  assert.equal(limited.length, 3)
  assert.ok(limited[0].id > limited[1].id)
})

test('缺陷回归：run 已终态后创建的报告立即收尾，不停留在 running', async (t) => {
  const { tmp, store, task, s } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  // 造一个已落终态的 agent run（报告中不含该用例的显式结论 → 按设计回落 blocked，不伪造成 pass）
  const run = store.createAgentRun(s.id, { prompt: 'no verdicts here', cwd: '/tmp' })
  store.finishAgentRun(run.id, { status: 'success' })
  assert.equal(store.getAgentRun(run.id).status, 'success')

  // 在 run 已终态之后才建报告：若不兜底会永远停在 running
  const rep = store.createTestReport(task.id, { caseId: c.id, runId: run.id, kind: 'regression' })
  assert.notEqual(rep.status, 'running')
  assert.equal(rep.status, 'blocked')
  assert.equal(rep.autoFinalized, true)

  // 仍处于 running 的 run 不受影响
  const liveRun = store.createAgentRun(s.id, { prompt: 'still running', cwd: '/tmp' })
  const liveRep = store.createTestReport(task.id, { caseId: c.id, runId: liveRun.id, kind: 'regression' })
  assert.equal(liveRep.status, 'running')
})

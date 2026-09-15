import test from 'node:test'
import assert from 'node:assert/strict'
import { tempHome } from './helpers.mjs'

async function setup() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  return { tmp, store, p, r }
}

// ---------- 权限判定（纯函数） ----------

test('checkRiskPermission：user / cli / import 放行；ai / mcp 需确认', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  for (const a of ['user', 'cli', 'import']) {
    const d = store.checkRiskPermission('regression.run', { actor: a })
    assert.equal(d.allowed, true, a)
    assert.equal(d.requiresConfirm, false, a)
  }
  for (const a of ['ai', 'mcp']) {
    const d = store.checkRiskPermission('regression.run', { actor: a })
    assert.equal(d.allowed, false, a)
    assert.equal(d.requiresConfirm, true, a)
    assert.equal(d.reason, 'ai-requires-confirm', a)
    const ok = store.checkRiskPermission('regression.run', { actor: a, confirm: true })
    assert.equal(ok.allowed, true, a)
    assert.equal(ok.reason, 'confirmed', a)
  }
})

test('checkRiskPermission：未知 action / 非高风险 action 一律 VALIDATION_FAILED（不当作放行）', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(() => store.checkRiskPermission('bogus.action', { actor: 'user' }), /VALIDATION_FAILED/)
  assert.throws(() => store.checkRiskPermission('node.create', { actor: 'user' }), /VALIDATION_FAILED/)
})

// ---------- 高风险操作的审批与留痕 ----------

test('requireRiskPermission：AI 未确认 → PERMISSION_DENIED 且留 denied 审计；确认后 allowed/confirmed', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(
    () => store.requireRiskPermission('requirement.transition', { actor: 'ai', nodeId: r.id, detail: { to: 'doing' } }),
    (e) => e.code === 'PERMISSION_DENIED' && e.details.confirmRequired === true
  )
  const denied = store.listAuditLogs({ action: 'requirement.transition', decision: 'denied' })
  assert.equal(denied.length, 1)
  assert.equal(denied[0].actor, 'ai')
  assert.deepEqual(denied[0].detail, { to: 'doing' })

  const ok = store.requireRiskPermission('requirement.transition', { actor: 'ai', confirm: true, nodeId: r.id })
  assert.equal(ok.ok, true)
  assert.equal(ok.audit.decision, 'confirmed')

  // 人工通道默认 allowed
  const manual = store.requireRiskPermission('requirement.transition', { actor: 'cli', nodeId: r.id })
  assert.equal(manual.audit.decision, 'allowed')
  assert.equal(manual.audit.actor, 'cli')
})

test('需求状态流转：AI 需确认（拒绝留痕），人工放行', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  // AI 未确认 → 拒绝，状态不变
  assert.throws(() => store.transitionRequirement(r.id, { status: 'doing', actor: 'ai' }), /PERMISSION_DENIED/)
  assert.equal(store.getNode(r.id).status, 'todo')
  assert.equal(store.listAuditLogs({ action: 'requirement.transition', decision: 'denied' }).length, 1)

  // AI 确认 → 流转成功
  const moved = store.transitionRequirement(r.id, { status: 'doing', actor: 'ai', confirm: true })
  assert.equal(moved.status, 'doing')
  assert.equal(store.listAuditLogs({ action: 'requirement.transition', decision: 'confirmed' }).length, 1)

  // 人工（cli）默认放行，无需 confirm
  const manual = store.transitionRequirement(r.id, { status: 'testing', actor: 'cli' })
  assert.equal(manual.status, 'testing')
  assert.equal(store.listAuditLogs({ action: 'requirement.transition', decision: 'allowed' }).length, 1)
})

test('上线项变更：AI 需确认；拒绝留痕、确认后写入；user 放行', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  // AI 新增未确认 → 拒绝，未落库
  assert.throws(
    () => store.createReleaseItem(r.id, { name: '建索引', kind: 'sql' }, 'ai'),
    /PERMISSION_DENIED/
  )
  assert.equal(store.listReleaseItems(r.id).length, 0)
  assert.equal(store.listAuditLogs({ action: 'release.item.write', decision: 'denied' }).length, 1)

  // AI 确认后写入
  const item = store.createReleaseItem(r.id, { name: '建索引', kind: 'sql' }, 'ai', { confirm: true })
  assert.ok(item.id > 0)
  assert.equal(store.listAuditLogs({ action: 'release.item.write', decision: 'confirmed' }).length, 1)

  // 人工更新 / 删除默认放行
  store.updateReleaseItem(item.id, { status: 'done' }, 'user')
  store.deleteReleaseItem(item.id, 'cli')
  assert.equal(store.listReleaseItems(r.id).length, 0)
  assert.equal(store.listAuditLogs({ action: 'release.item.write', decision: 'allowed' }).length, 2)
})

test('审计日志：按 action / nodeId / decision 筛选，倒序，非法值拒绝', async (t) => {
  const { tmp, store, p, r } = await setup()
  t.after(() => tmp.cleanup())
  store.recordAudit({ action: 'regression.run', nodeId: r.id, actor: 'ai', decision: 'confirmed', detail: { n: 1 } })
  store.recordAudit({ action: 'release.check', nodeId: r.id, actor: 'ai', decision: 'allowed' })
  store.recordAudit({ action: 'regression.run', nodeId: p.id, actor: 'cli', decision: 'allowed' })

  const all = store.listAuditLogs()
  assert.equal(all.length, 3)
  assert.ok(all[0].id > all[1].id, '倒序')
  assert.equal(store.listAuditLogs({ action: 'regression.run' }).length, 2)
  assert.equal(store.listAuditLogs({ nodeId: r.id }).length, 2)
  assert.equal(store.listAuditLogs({ decision: 'confirmed' }).length, 1)
  assert.equal(store.listAuditLogs({ action: 'release.check', nodeId: r.id }).length, 1)
  assert.equal(store.listAuditLogs({ limit: 1 }).length, 1)
  assert.deepEqual(all.find((l) => l.detail).detail, { n: 1 })

  assert.throws(() => store.listAuditLogs({ action: 'bogus' }), /VALIDATION_FAILED/)
  assert.throws(() => store.listAuditLogs({ decision: 'bogus' }), /VALIDATION_FAILED/)
  assert.throws(() => store.recordAudit({ action: 'bogus', decision: 'allowed' }), /VALIDATION_FAILED/)
  assert.throws(() => store.recordAudit({ action: 'regression.run', decision: 'bogus' }), /VALIDATION_FAILED/)
})

test('审计是旁路观测：写审计日志不额外 bump revision', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const before = store.getRevision()
  store.recordAudit({ action: 'release.check', nodeId: r.id, actor: 'ai', decision: 'allowed' })
  assert.equal(store.getRevision(), before)
})

test('派单高风险：dryRun 预演不受限，真派单 AI 未确认被拒（拒绝发生在派单前）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases, runReleaseChecks } = await import('../server/ops.mjs')
  store.createTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })

  // dryRun 只预演，不需要确认（即使 AI）
  const dry = runTestCases(store, r.id, { dryRun: true }, 'ai')
  assert.equal(dry.dryRun, true)
  assert.equal(store.listAuditLogs({ action: 'regression.run' }).length, 0)
  const dryRelease = runReleaseChecks(store, r.id, { dryRun: true }, 'ai')
  assert.equal(dryRelease.dryRun, true)

  // 真派单 AI 未确认 → PERMISSION_DENIED，且没产生 run / 报告
  assert.throws(() => runTestCases(store, r.id, { agent: 'echo', cwd: '/tmp' }, 'ai'), /PERMISSION_DENIED/)
  assert.equal(store.listTestReports(r.id).length, 0)
  assert.equal(store.listAuditLogs({ action: 'regression.run', decision: 'denied' }).length, 1)

  assert.throws(() => runReleaseChecks(store, r.id, { agent: 'echo', cwd: '/tmp' }, 'ai'), /PERMISSION_DENIED/)
  assert.equal(store.listAuditLogs({ action: 'release.check', decision: 'denied' }).length, 1)

  // 人工（cli）真派单默认放行（走到 startAgentRun；无仓库会报运行目录错，但审计已记为 allowed）
  try {
    runTestCases(store, r.id, { agent: 'echo', cwd: '/tmp' }, 'cli')
  } catch {
    /* 允许派单阶段失败；这里断言的是权限已放行 */
  }
  assert.equal(store.listAuditLogs({ action: 'regression.run', decision: 'allowed' }).length, 1)
})

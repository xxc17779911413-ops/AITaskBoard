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

// ---------- release_items ----------

test('release_item：创建 / 列表 / 默认类型与状态', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const item = store.createReleaseItem(task.id, { name: '开灰度开关', content: 'switch=on' })
  assert.ok(item.id > 0)
  assert.equal(item.kind, 'config')
  assert.equal(item.status, 'pending')
  assert.equal(item.required, true)
  assert.equal(store.listReleaseItems(task.id).length, 1)
})

test('release_item：名称在同节点内唯一，重名报 RELEASE_ITEM_NAME_EXISTS', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(task.id, { name: 'A', content: 'x' })
  assert.throws(() => store.createReleaseItem(task.id, { name: 'A', content: 'y' }), /RELEASE_ITEM_NAME_EXISTS/)
  const b = store.createReleaseItem(task.id, { name: 'B', content: 'x' })
  assert.throws(() => store.updateReleaseItem(b.id, { name: 'A' }), /RELEASE_ITEM_NAME_EXISTS/)
})

test('release_item：名称必填，非法 kind / status 拒绝', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(() => store.createReleaseItem(task.id, { name: '  ' }), /名称必填/)
  assert.throws(() => store.createReleaseItem(task.id, { name: 'X', kind: 'bogus' }), /未知上线项类型/)
  assert.throws(() => store.createReleaseItem(task.id, { name: 'X', status: 'bogus' }), /未知上线项状态/)
})

test('release_item：upsert 按名幂等并覆盖，created 标记正确', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const first = store.upsertReleaseItem(task.id, { name: '建索引', kind: 'sql', content: 'CREATE INDEX …' })
  assert.equal(first.created, true)
  const second = store.upsertReleaseItem(task.id, { name: '建索引', kind: 'sql', content: 'CREATE INDEX … v2', status: 'ready' })
  assert.equal(second.created, false)
  assert.equal(second.id, first.id)
  assert.equal(second.content, 'CREATE INDEX … v2')
  assert.equal(second.status, 'ready')
  assert.equal(store.listReleaseItems(task.id).length, 1)
})

test('release_item：kind / status 筛选与 includeOptional', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(task.id, { name: 'C1', kind: 'config' })
  store.createReleaseItem(task.id, { name: 'S1', kind: 'sql', status: 'done' })
  store.createReleaseItem(task.id, { name: 'K1', kind: 'check', required: 0 })
  assert.equal(store.listReleaseItems(task.id).length, 3)
  assert.equal(store.listReleaseItems(task.id, { kind: 'sql' }).length, 1)
  assert.equal(store.listReleaseItems(task.id, { status: 'done' }).length, 1)
  assert.equal(store.listReleaseItems(task.id, { includeOptional: false }).length, 2)
})

test('release_item：排序 / 删除 / 删除不存在报 NOT_FOUND', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const a = store.createReleaseItem(task.id, { name: 'A' })
  const b = store.createReleaseItem(task.id, { name: 'B' })
  const c = store.createReleaseItem(task.id, { name: 'C' })
  store.reorderReleaseItems(task.id, [c.id, a.id, b.id])
  assert.deepEqual(store.listReleaseItems(task.id).map((x) => x.name), ['C', 'A', 'B'])
  store.deleteReleaseItem(b.id)
  assert.deepEqual(store.listReleaseItems(task.id).map((x) => x.name), ['C', 'A'])
  assert.throws(() => store.deleteReleaseItem(b.id), /NOT_FOUND/)
})

test('release_item：随节点级联删除', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(task.id, { name: 'A' })
  store.deleteNode(task.id)
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM release_items').get().c, 0)
})

test('release_item：每次写入 revision +1，组合 reorder 只 +1', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const a = store.createReleaseItem(task.id, { name: 'A' })
  const b = store.createReleaseItem(task.id, { name: 'B' })
  const before = store.getRevision()
  store.reorderReleaseItems(task.id, [b.id, a.id])
  assert.equal(store.getRevision(), before + 1)
  store.updateReleaseItem(a.id, { status: 'done' })
  assert.equal(store.getRevision(), before + 2)
})

// ---------- 上线检查清单聚合 ----------

test('release_checklist：必做项未完成 → 未就绪，blockers 列出必做未完成项', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '跑上线 SQL', kind: 'sql' })
  store.createReleaseItem(r.id, { name: '灰度开关', kind: 'config', status: 'done' })
  store.createReleaseItem(r.id, { name: '可选监控', kind: 'check', required: 0 })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, false)
  assert.equal(checklist.totals.items, 3)
  assert.equal(checklist.totals.required, 2)
  assert.equal(checklist.totals.optional, 1)
  assert.equal(checklist.totals.done, 1)
  assert.equal(checklist.blockers.length, 1)
  assert.equal(checklist.blockers[0].name, '跑上线 SQL')
  assert.equal(checklist.byKind.sql, 1)
})

test('release_checklist：必做项全部 done/skipped → 就绪；可选未完成不影响', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: 'A', status: 'done' })
  store.createReleaseItem(r.id, { name: 'B', status: 'skipped' })
  store.createReleaseItem(r.id, { name: 'C', required: 0 })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, true)
  assert.equal(checklist.blockers.length, 0)
})

test('release_checklist：无必做项时 ready=null（不用 0 冒充未就绪）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  assert.equal(store.buildReleaseChecklist(r.id).ready, null)
  store.createReleaseItem(r.id, { name: '仅可选', required: 0 })
  assert.equal(store.buildReleaseChecklist(r.id).ready, null)
})

test('release_checklist：scope=subtree 聚合子树，self 只管本节点', async (t) => {
  const { tmp, store, r, s } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: 'R 的上线项' })
  store.createReleaseItem(s.id, { name: 'S 的上线项', status: 'done' })
  assert.equal(store.buildReleaseChecklist(r.id, { scope: 'self' }).totals.items, 1)
  assert.equal(store.buildReleaseChecklist(r.id, { scope: 'subtree' }).totals.items, 2)
  assert.equal(store.buildReleaseChecklist(r.id, { scope: 'subtree' }).ready, false)
})

test('release_checklist：blocked 状态计入 totals.blocked', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '卡住的上线 SQL', status: 'blocked' })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.totals.blocked, 1)
  assert.equal(checklist.ready, false)
})

// ---------- 检查用例纳入上线就绪判定（假绿灯回归） ----------
//
// 每次改动先写出「在旧实现上会失败」的用例：旧实现只看 release_items，
// 必做项全 done 就报 ready=true，哪怕登记的 code_check 从未执行、或最近一次已经 FAIL。

test('release_checklist：必做项全完成但登记的 code_check 从未执行 → 未就绪（旧实现会假绿）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'done' })
  const lint = store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, false)
  assert.equal(checklist.blockers.length, 0)
  assert.equal(checklist.totals.checkCases, 1)
  assert.equal(checklist.totals.checkNotRun, 1)
  assert.equal(checklist.totals.checkBlocking, 1)
  assert.equal(checklist.caseBlockers.length, 1)
  assert.equal(checklist.caseBlockers[0].id, lint.id)
  assert.equal(checklist.caseBlockers[0].latestStatus, 'not_run')
})

test('release_checklist：检查用例最近一次 pass 后才就绪；失败重新阻塞', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'done' })
  const lint = store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  const report = store.createTestReport(r.id, { caseId: lint.id, kind: 'code_check', status: 'running' })
  store.finishTestReport(report.id, { status: 'pass', summary: '无告警' })
  assert.equal(store.buildReleaseChecklist(r.id).ready, true)
  assert.deepEqual(store.buildReleaseChecklist(r.id).caseBlockers, [])

  // 再跑一次失败：最近结论翻转，就绪必须跟着翻转（不能被上一条 pass 掩盖）
  const second = store.createTestReport(r.id, { caseId: lint.id, kind: 'code_check', status: 'running' })
  store.finishTestReport(second.id, { status: 'fail', summary: '2 处 lint 错误' })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, false)
  assert.equal(checklist.caseBlockers[0].latestStatus, 'fail')
  assert.equal(checklist.caseBlockers[0].latestReportId, second.id)
})

test('release_checklist：running 的检查用例不算通过（派单未回写不假绿）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'done' })
  const biz = store.createTestCase(r.id, { name: '下单回归', prompt: '跑下单', kind: 'biz_check' })
  store.createTestReport(r.id, { caseId: biz.id, kind: 'biz_check', status: 'running' })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, false)
  assert.equal(checklist.totals.checkRunning, 1)
  assert.equal(checklist.caseBlockers[0].latestStatus, 'running')
})

test('release_checklist：只有检查用例、没有必做上线项时也有可判定结论（不再是空态 null）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  // 无可判定对象（无必做项且无检查用例）→ 空态
  assert.equal(store.buildReleaseChecklist(r.id).ready, null)
  store.createReleaseItem(r.id, { name: '可选监控', kind: 'check', required: 0 })
  assert.equal(store.buildReleaseChecklist(r.id).ready, null)
  // 登记检查用例后即产生可判定对象：未执行 → false
  const rel = store.createTestCase(r.id, { name: '上线冒烟', prompt: '跑冒烟', kind: 'release_check' })
  assert.equal(store.buildReleaseChecklist(r.id).ready, false)
  const report = store.createTestReport(r.id, { caseId: rel.id, kind: 'release_check', status: 'running' })
  store.finishTestReport(report.id, { status: 'pass', summary: '通过' })
  assert.equal(store.buildReleaseChecklist(r.id).ready, true)
})

test('release_checklist：停用的检查用例既不被派单也不阻塞上线', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'done' })
  store.createTestCase(r.id, { name: '已停用检查', prompt: '不再跑', kind: 'code_check', enabled: 0 })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.totals.checkCases, 0)
  assert.equal(checklist.ready, true)
})

test('release_checklist：scope=subtree 纳入子树的检查用例并阻塞本节点', async (t) => {
  const { tmp, store, r, s } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: 'R 的上线 SQL', kind: 'sql', status: 'done' })
  store.createTestCase(s.id, { name: '子树静态检查', prompt: '跑 lint', kind: 'code_check' })
  // self 只管本节点，看不到子树的检查用例
  assert.equal(store.buildReleaseChecklist(r.id, { scope: 'self' }).ready, true)
  // subtree 必须纳入
  const subtree = store.buildReleaseChecklist(r.id, { scope: 'subtree' })
  assert.equal(subtree.ready, false)
  assert.equal(subtree.totals.checkCases, 1)
  assert.equal(subtree.caseBlockers[0].nodeId, s.id)
})

test('release_checklist：检查用例纳入后仍是纯读聚合，不产生 revision', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'done' })
  store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  const before = store.getRevision()
  store.buildReleaseChecklist(r.id)
  store.buildReleaseChecklist(r.id, { scope: 'subtree' })
  assert.equal(store.getRevision(), before)
})

test('release_checklist：markdown 输出检查用例阻塞项', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'done' })
  store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  const { renderReleaseChecklistMd } = await import('../server/ops.mjs')
  const md = renderReleaseChecklistMd(store.buildReleaseChecklist(r.id))
  assert.ok(md.includes('上线就绪：否'))
  assert.ok(md.includes('## 检查用例阻塞项'))
  assert.ok(md.includes('| 静态检查 | 代码检查 | 未执行 |'))
  assert.ok(md.includes('## 检查用例明细'))
})

// ---------- 编排层（上线前置检查 dryRun / 提示词 / markdown） ----------

test('runReleaseChecks：无上线项且无检查用例时报错', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runReleaseChecks } = await import('../server/ops.mjs')
  assert.throws(() => runReleaseChecks(store, task.id, { dryRun: true }), /没有可执行的上线检查/)
})

test('runReleaseChecks：dryRun 拼上线清单与检查用例、不落库不派单', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runReleaseChecks } = await import('../server/ops.mjs')
  store.createReleaseItem(task.id, { name: '开灰度开关', kind: 'config', content: 'switch=on', rollback: 'switch=off' })
  const codeCase = store.createTestCase(task.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  store.createTestCase(task.id, { name: '普通回归', prompt: '跑回归', kind: 'regression' })
  const out = runReleaseChecks(store, task.id, { dryRun: true })
  assert.equal(out.dryRun, true)
  // 只挑 code_check / biz_check / release_check，普通回归不进入上线检查
  assert.deepEqual(out.cases.map((c) => c.name), ['静态检查'])
  assert.equal(out.items.length, 1)
  assert.ok(out.prompt.includes('开灰度开关'))
  assert.ok(out.prompt.includes('回滚：switch=off'))
  assert.ok(out.prompt.includes('静态检查'))
  assert.ok(out.prompt.includes('PASS|FAIL|BLOCKED'))
  assert.equal(store.listTestReports(task.id).length, 0)
  void codeCase
})

test('runReleaseChecks：只登记上线项（无检查用例）也能 dryRun', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runReleaseChecks } = await import('../server/ops.mjs')
  store.createReleaseItem(task.id, { name: '执行上线 SQL', kind: 'sql' })
  const out = runReleaseChecks(store, task.id, { dryRun: true })
  assert.equal(out.cases.length, 0)
  assert.equal(out.items.length, 1)
  assert.equal(out.ready, false)
})

test('runReleaseChecks：caseIds 过滤检查用例', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runReleaseChecks } = await import('../server/ops.mjs')
  const a = store.createTestCase(task.id, { name: 'A', prompt: 'p', kind: 'code_check' })
  store.createTestCase(task.id, { name: 'B', prompt: 'p', kind: 'biz_check' })
  const out = runReleaseChecks(store, task.id, { dryRun: true, caseIds: [a.id] })
  assert.deepEqual(out.cases.map((c) => c.name), ['A'])
})

test('runReleaseChecks：显式 caseIds=[] 表示只执行上线清单，缺省才不过滤', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runReleaseChecks } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: 'p', kind: 'code_check' })
  store.createReleaseItem(task.id, { name: '执行上线 SQL', kind: 'sql' })

  const empty = runReleaseChecks(store, task.id, { dryRun: true, caseIds: [] })
  assert.equal(empty.cases.length, 0)
  assert.equal(empty.items.length, 1)

  const unspecified = runReleaseChecks(store, task.id, { dryRun: true })
  assert.deepEqual(unspecified.cases.map((c) => c.name), ['A'])
})

test('renderReleaseChecklistMd：输出可贴进上线单的 markdown', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const { renderReleaseChecklistMd } = await import('../server/ops.mjs')
  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql' })
  store.createReleaseItem(r.id, { name: '灰度开关', kind: 'config', status: 'done', rollback: '关闭' })
  const md = renderReleaseChecklistMd(store.buildReleaseChecklist(r.id))
  assert.ok(md.startsWith('# 上线检查'))
  assert.ok(md.includes('上线就绪：否'))
  assert.ok(md.includes('## 阻塞项'))
  assert.ok(md.includes('执行上线 SQL'))
  assert.ok(md.includes('| 灰度开关 | 上线配置 | done | 是 | 有 |'))
})

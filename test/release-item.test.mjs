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

test('release_checklist：必做项全 done 但检查用例未执行 → 未就绪（堵住假绿灯）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '开灰度开关', status: 'done' })
  store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  const checklist = store.buildReleaseChecklist(r.id)
  // 旧实现只扫 release_items，必做项全 done 就报 ready=true，登记却从没跑的代码检查被静默忽略
  assert.equal(checklist.ready, false)
  assert.equal(checklist.totals.checkCases, 1)
  assert.equal(checklist.totals.checkPending, 1)
  assert.deepEqual(checklist.caseBlockers.map((c) => [c.name, c.latestStatus]), [['静态检查', 'not_run']])
})

test('release_checklist：检查用例最近一次 pass 才算就绪；历史 pass 不掩盖后来的 fail', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '开灰度开关', status: 'done' })
  const c = store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  const first = store.createTestReport(r.id, { caseId: c.id, kind: 'code_check' })
  store.finishTestReport(first.id, { status: 'pass' })
  // 只有一条 pass → 就绪
  assert.equal(store.buildReleaseChecklist(r.id).ready, true)
  // 再来一条 fail（最近一次） → 不再就绪，历史 pass 不能掩盖
  const second = store.createTestReport(r.id, { caseId: c.id, kind: 'code_check' })
  store.finishTestReport(second.id, { status: 'fail' })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, false)
  assert.equal(checklist.totals.checkPass, 0)
  assert.equal(checklist.caseBlockers[0].latestStatus, 'fail')
  assert.equal(checklist.caseBlockers[0].latestReportId, second.id)
})

test('release_checklist：停用检查用例不阻塞；running 单列且不算通过', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '开灰度开关', status: 'done' })
  store.createTestCase(r.id, { name: '已停用的检查', prompt: 'p', kind: 'biz_check', enabled: 0 })
  const run = store.createTestCase(r.id, { name: '跑着的检查', prompt: 'p', kind: 'release_check' })
  store.createTestReport(r.id, { caseId: run.id, kind: 'release_check', status: 'running' })
  const checklist = store.buildReleaseChecklist(r.id)
  // 停用用例不计入，不阻塞；running 计入但不算通过
  assert.equal(checklist.totals.checkCases, 1)
  assert.equal(checklist.totals.checkRunning, 1)
  assert.equal(checklist.ready, false)
})

test('release_checklist：只有检查用例时空态不再是 ready=null', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  // 无必做项、无检查用例 → null（不适用）
  assert.equal(store.buildReleaseChecklist(r.id).ready, null)
  // 有检查用例但没跑 → false（不能报 null，否则会被当成不适用而不阻塞）
  store.createTestCase(r.id, { name: '静态检查', prompt: 'p', kind: 'code_check' })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, false)
  assert.equal(checklist.totals.required, 0)
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

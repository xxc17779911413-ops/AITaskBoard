import test from 'node:test'
import assert from 'node:assert/strict'
import { tempHome } from './helpers.mjs'

async function setup() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p1 = store.createNode({ type: 'project', name: '项目A' })
  const p2 = store.createNode({ type: 'project', name: '项目B' })
  return { tmp, store, p1, p2 }
}

async function setupWithStatus(allowedRequirement) {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb(), {
    status: { allowed: { requirement: allowedRequirement } }
  })
  const p = store.createNode({ type: 'project', name: '项目A' })
  return { tmp, store, p }
}

test('需求条目：创建时关联需求内容与概要设计两份文档', async () => {
  const { tmp, store, p1 } = await setup()
  const r = store.createRequirement({ projectId: p1.id, name: '需求A' })
  assert.equal(r.type, 'requirement')
  assert.equal(r.projectId, p1.id)
  assert.deepEqual(
    r.docState.map((d) => [d.name, d.linked, d.filled]),
    [
      ['需求内容', true, false],
      ['概要设计', true, false]
    ]
  )
  assert.equal(r.readiness.ready, false)
  tmp.cleanup()
})

test('需求列表与 KPI：可按项目 / 状态筛选，并统计文档缺口', async () => {
  const { tmp, store, p1, p2 } = await setup()
  const a = store.createRequirement({ projectId: p1.id, name: 'A' })
  store.createRequirement({ projectId: p2.id, name: 'B' })
  store.transitionRequirement(a.id, { status: 'doing' })
  store.upsertDocument(a.id, '需求内容', '正文')

  assert.equal(store.listRequirements({ projectId: p1.id }).length, 1)
  assert.equal(store.listRequirements({ status: 'doing' }).length, 1)
  const summary = store.requirementSummary({ projectId: p1.id })
  assert.equal(summary.total, 1)
  assert.equal(summary.byStatus.doing, 1)
  assert.equal(summary.missingRequirementDoc, 0)
  assert.equal(summary.missingDesignDoc, 1)
  tmp.cleanup()
})

test('需求状态机：合法路径逐段推进，非法跳转拒绝', async () => {
  const { tmp, store, p1 } = await setup()
  const r = store.createRequirement({ projectId: p1.id, name: 'R' })
  assert.equal(store.transitionRequirement(r.id, { status: 'doing' }).status, 'doing')
  assert.equal(store.transitionRequirement(r.id, { status: 'testing' }).status, 'testing')
  assert.equal(store.transitionRequirement(r.id, { status: 'done' }).status, 'done')
  assert.throws(() => store.transitionRequirement(r.id, { status: 'todo' }), /VALIDATION_FAILED/)
  tmp.cleanup()
})

test('需求状态机：未完成前可取消，取消后可恢复待开始', async () => {
  const { tmp, store, p1 } = await setup()
  const r = store.createRequirement({ projectId: p1.id, name: 'R' })
  assert.equal(store.transitionRequirement(r.id, { status: 'cancelled' }).status, 'cancelled')
  assert.equal(store.transitionRequirement(r.id, { status: 'todo' }).status, 'todo')
  tmp.cleanup()
})

test('通用 node.update 也不能绕过需求状态机', async () => {
  const { tmp, store, p1 } = await setup()
  const r = store.createRequirement({ projectId: p1.id, name: 'R' })
  assert.throws(() => store.updateNode(r.id, { status: 'done' }), /VALIDATION_FAILED/)
  assert.equal(store.getNode(r.id).status, 'todo')
  tmp.cleanup()
})

test('通用 create/update 对枚举外状态值统一拒绝', async () => {
  const { tmp, store, p1 } = await setup()
  assert.throws(() => store.createNode({ parentId: p1.id, type: 'requirement', name: 'R', status: 'DONE' }), /VALIDATION_FAILED/)
  assert.throws(() => store.createNode({ parentId: p1.id, type: 'requirement', name: 'R2', status: 'bogus' }), /VALIDATION_FAILED/)
  assert.throws(() => store.createNode({ parentId: p1.id, type: 'requirement', name: 'R done', status: 'done' }), /VALIDATION_FAILED/)

  const r = store.createRequirement({ projectId: p1.id, name: 'R3' })
  assert.throws(() => store.updateNode(r.id, { status: 'DONE' }), /VALIDATION_FAILED/)
  assert.throws(() => store.updateNode(r.id, { status: 'done' }), /VALIDATION_FAILED/)
  assert.equal(store.getNode(r.id).status, 'todo')
  tmp.cleanup()
})

test('通用创建 type=requirement 必须生成与专属创建一致的两份文档槽位', async () => {
  const { tmp, store, p1 } = await setup()
  const generic = store.createNode({ parentId: p1.id, type: 'requirement', name: '通用创建' })
  const dedicated = store.createRequirement({ projectId: p1.id, name: '专属创建' })
  const shape = (node) =>
    store
      .listRequirements({ projectId: p1.id })
      .find((r) => r.id === node.id)
      .docState.map((d) => [d.name, d.linked, d.filled])
  assert.deepEqual(shape(generic), shape(dedicated))
  assert.deepEqual(shape(generic), [
    ['需求内容', true, false],
    ['概要设计', true, false]
  ])
  tmp.cleanup()
})

test('status 筛选下 summary 与 items 口径一致', async () => {
  const { tmp, store, p1 } = await setup()
  const a = store.createRequirement({ projectId: p1.id, name: 'A' })
  store.createRequirement({ projectId: p1.id, name: 'B' })
  store.transitionRequirement(a.id, { status: 'doing' })

  const out = store.listRequirements({ projectId: p1.id, status: 'doing' })
  const summary = store.requirementSummary({ projectId: p1.id, status: 'doing' })
  assert.equal(out.length, 1)
  assert.equal(summary.total, 1)
  assert.deepEqual(summary.byStatus, { todo: 0, doing: 1, testing: 0, done: 0, cancelled: 0 })
  tmp.cleanup()
})

test('自定义图外需求状态必须在启动期拒绝，不能成为直达 done 的走廊', async () => {
  const tmp = await tempHome()
  assert.throws(
    () =>
      tmp.store.createStore(tmp.openDb(), {
        status: { allowed: { requirement: ['todo', 'doing', 'testing', 'done', 'cancelled', 'blocked'] } }
      }),
    /VALIDATION_FAILED/
  )
  tmp.cleanup()
})

test('收窄需求状态配置后，canTransitionTo / 流转 / KPI 共用同一有效状态集', async () => {
  const { tmp, store, p } = await setupWithStatus(['todo', 'doing', 'testing', 'done'])
  const r = store.createRequirement({ projectId: p.id, name: 'R' })
  assert.deepEqual(r.canTransitionTo, ['doing'])

  const doing = store.transitionRequirement(r.id, { status: 'doing' })
  assert.deepEqual(doing.canTransitionTo, ['testing'])
  assert.throws(() => store.transitionRequirement(r.id, { status: 'cancelled' }), /VALIDATION_FAILED/)
  assert.throws(() => store.updateNode(r.id, { status: 'done' }), /VALIDATION_FAILED/)

  const testing = store.transitionRequirement(r.id, { status: 'testing' })
  assert.deepEqual(testing.canTransitionTo, ['done'])
  const done = store.transitionRequirement(r.id, { status: 'done' })
  assert.deepEqual(done.canTransitionTo, [])

  const summary = store.requirementSummary({ projectId: p.id })
  assert.deepEqual(summary.byStatus, { todo: 0, doing: 0, testing: 0, done: 1 })
  assert.equal(summary.total, 1)
  tmp.cleanup()
})

test('终态不可达或非终态无出边的 workflow 必须在启动期拒绝', async () => {
  for (const allowed of [
    ['todo'],
    ['todo', 'doing', 'done'],
    ['todo', 'done']
  ]) {
    const tmp = await tempHome()
    assert.throws(
      () => tmp.store.createStore(tmp.openDb(), { status: { allowed: { requirement: allowed } } }),
      /VALIDATION_FAILED/,
      allowed.join(',')
    )
    tmp.cleanup()
  }
})

test('历史图外状态数据：summary.total 与列表行数一致并显式计数 unknown', async () => {
  const { tmp, store, p } = await setupWithStatus(['todo', 'doing', 'testing', 'done'])
  const a = store.createRequirement({ projectId: p.id, name: 'A' })
  const b = store.createRequirement({ projectId: p.id, name: 'B' })
  store.db.prepare("UPDATE nodes SET status = 'DONE' WHERE id = ?").run(b.id)
  store.db.prepare("UPDATE nodes SET status = 'cancelled' WHERE id = ?").run(a.id)

  const items = store.listRequirements({ projectId: p.id })
  const summary = store.requirementSummary({ projectId: p.id })
  assert.equal(items.length, 2)
  assert.equal(summary.total, items.length)
  assert.equal(summary.unknownStatusCount, 2)
  assert.deepEqual(summary.byStatus, { todo: 0, doing: 0, testing: 0, done: 0 })
  tmp.cleanup()
})

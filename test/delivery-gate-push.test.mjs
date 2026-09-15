import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tempHome } from './helpers.mjs'

/**
 * 交付门禁 × 代码推送：把「登记提交是否真的到了远程」并入唯一交付结论。
 *
 * 背景（决策 36 的后续）：push gate 首版刻意不并入 delivery_gate，
 * 于是「需求就绪 + 测试通过」就能算出 ready=true，哪怕登记的提交根本没 push。
 * 本文件锁住收口后的口径：未推送 / 无法判定都必须阻塞交付，且不产生假绿灯。
 */

/**
 * 临时 git 仓库 + 裸远程：
 * - main：已 push（remote-tracking ref 存在）
 * - feature：新提交，默认未 push
 */
function makeRepo({ withRemote = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-dg-push-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  const g = (args, cwd = dir) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t.local'])
  g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])

  if (withRemote) {
    const remoteDir = path.join(root, 'remote.git')
    g(['init', '-q', '--bare', remoteDir], root)
    g(['remote', 'add', 'origin', remoteDir])
    g(['push', '-q', '-u', 'origin', 'main'])
  }

  g(['checkout', '-q', '-b', 'feature'])
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'feat: b'])
  const featureSha = g(['rev-parse', 'HEAD']).trim()
  const mainSha = g(['rev-parse', 'main']).trim()
  return { root, dir, g, featureSha, mainSha }
}

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const ops = await import('../server/ops.mjs')
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  return { tmp, store, ops, p, r, s }
}

/** 把节点补到「除推送外都通过」：需求文档 + 回归用例 + pass 报告 + 验收签收 */
function makeNonPushPass(store, nodeId) {
  store.upsertDocument(nodeId, '需求内容', '需求正文')
  store.upsertDocument(nodeId, '概要设计', '设计正文')
  const testCase = store.upsertTestCase(nodeId, { name: '回归用例', prompt: '跑单测' })
  const report = store.createTestReport(nodeId, { caseId: testCase.id, status: 'running', kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass', summary: '全绿' })
  // 交付门禁自决策 39 起要求有效验收签收；只写测试结论不足以让 acceptance 来源 pass。
  store.upsertAcceptanceSignoff(nodeId, { decision: 'accepted', comment: '验收通过' })
  return testCase
}

const sourceOf = (gate, key) => gate.sources.find((s) => s.key === key)

test('delivery_gate × push：已登记的提交未 push → not_ready，push 来源 fail', async (t) => {
  const { tmp, store, ops, r } = await setup()
  const { root, dir, featureSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  makeNonPushPass(store, r.id)
  store.addRepo({ name: 'repo', localPath: dir })
  store.addCommit(r.id, { repo: 'repo', sha: featureSha })

  const gate = await ops.buildDeliveryGateFull(store, r.id)
  assert.equal(gate.decision, 'not_ready')
  assert.equal(gate.ready, false)
  assert.equal(sourceOf(gate, 'push').status, 'fail')
  assert.equal(sourceOf(gate, 'push').evidence.totals.notPushed, 1)
  assert.ok(
    gate.blockers.some((b) => b.source === 'push' && /未推送|没有任何远程跟踪分支/.test(b.detail)),
    `blockers=${JSON.stringify(gate.blockers)}`
  )
})

test('delivery_gate × push：push 后同一节点翻成 ready（推送是唯一变化）', async (t) => {
  const { tmp, store, ops, r } = await setup()
  const { root, dir, g, featureSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  makeNonPushPass(store, r.id)
  store.addRepo({ name: 'repo', localPath: dir })
  const commit = store.addCommit(r.id, { repo: 'repo', sha: featureSha })
  void commit

  assert.equal((await ops.buildDeliveryGateFull(store, r.id)).decision, 'not_ready')

  g(['push', '-q', '-u', 'origin', 'feature'])
  const gate = await ops.buildDeliveryGateFull(store, r.id)
  assert.equal(gate.decision, 'ready')
  assert.equal(sourceOf(gate, 'push').status, 'pass')
  assert.deepEqual(gate.blockers, [])
})

test('delivery_gate × push：未登记仓库 → push 来源 fail（unknown 不冒充通过）', async (t) => {
  const { tmp, store, ops, r } = await setup()
  t.after(() => tmp.cleanup())
  makeNonPushPass(store, r.id)
  // 登记提交但不登记仓库：push 判定只能给 unknown，必须阻塞交付
  store.addCommit(r.id, { sha: 'a'.repeat(40) })

  const gate = await ops.buildDeliveryGateFull(store, r.id)
  assert.equal(gate.decision, 'not_ready')
  assert.equal(sourceOf(gate, 'push').status, 'fail')
  assert.equal(sourceOf(gate, 'push').evidence.totals.unknown, 1)
})

test('delivery_gate × push：范围内没有登记提交 → not_applicable，不阻塞', async (t) => {
  const { tmp, store, ops, r } = await setup()
  t.after(() => tmp.cleanup())
  makeNonPushPass(store, r.id)

  const gate = await ops.buildDeliveryGateFull(store, r.id)
  assert.equal(gate.decision, 'ready')
  assert.equal(sourceOf(gate, 'push').status, 'not_applicable')
  assert.equal(sourceOf(gate, 'push').applicable, false)
})

test('delivery_gate × push：scope=subtree 纳入子树登记提交', async (t) => {
  const { tmp, store, ops, r, s } = await setup()
  const { root, dir, featureSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  makeNonPushPass(store, r.id)
  store.addRepo({ name: 'repo', localPath: dir })
  // 未推送提交挂在子节点上
  store.addCommit(s.id, { repo: 'repo', sha: featureSha })

  const selfGate = await ops.buildDeliveryGateFull(store, r.id, { scope: 'self' })
  assert.equal(selfGate.decision, 'ready')
  const subtreeGate = await ops.buildDeliveryGateFull(store, r.id, { scope: 'subtree' })
  assert.equal(subtreeGate.decision, 'not_ready')
  assert.equal(sourceOf(subtreeGate, 'push').status, 'fail')
})

test('delivery_gate × push：同 (repo,sha) 在多节点登记只算一次', async (t) => {
  const { tmp, store, ops, r, s } = await setup()
  const { root, dir, featureSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  makeNonPushPass(store, r.id)
  store.addRepo({ name: 'repo', localPath: dir })
  store.addCommit(r.id, { repo: 'repo', sha: featureSha })
  store.addCommit(s.id, { repo: 'repo', sha: featureSha })

  const gate = await ops.buildDeliveryGateFull(store, r.id, { scope: 'subtree' })
  assert.equal(sourceOf(gate, 'push').evidence.totals.commits, 1)
})

test('delivery_gate：同步调用 store 且有登记提交时不得放行（未注入推送证据 = fail）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  makeNonPushPass(store, r.id)
  store.addCommit(r.id, { sha: 'a'.repeat(40) })

  // 回归：buildDeliveryGate 是同步纯读入口，漏传 pushGate 时不能把「未判定」读成可交付。
  const gate = store.buildDeliveryGate(r.id)
  assert.equal(gate.decision, 'not_ready')
  assert.equal(sourceOf(gate, 'push').status, 'fail')
})

test('delivery_gate × push：纯读聚合不产生 revision（含推送判定）', async (t) => {
  const { tmp, store, ops, r } = await setup()
  const { root, dir, mainSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  store.addRepo({ name: 'repo', localPath: dir })
  store.addCommit(r.id, { repo: 'repo', sha: mainSha })
  const before = store.getRevision()
  await ops.buildDeliveryGateFull(store, r.id)
  await ops.buildDeliveryGateFull(store, r.id, { scope: 'subtree' })
  assert.equal(store.getRevision(), before)
})

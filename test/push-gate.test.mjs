import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tempHome } from './helpers.mjs'

/**
 * 临时 git 仓库 + 一个裸远程：
 * - main：已 push 到远程（remote-tracking ref 存在）
 * - feature：新提交 b，默认未 push
 */
function makeRepo({ withRemote = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-push-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  const g = (args, cwd = dir) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t.local'])
  g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])

  let remoteDir = null
  if (withRemote) {
    remoteDir = path.join(root, 'remote.git')
    g(['init', '-q', '--bare', remoteDir], root)
    g(['remote', 'add', 'origin', remoteDir])
    g(['push', '-q', '-u', 'origin', 'main'])
  }

  // feature 上的新提交：默认未推送
  g(['checkout', '-q', '-b', 'feature'])
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'feat: b'])
  const featureSha = g(['rev-parse', 'HEAD']).trim()
  const mainSha = g(['rev-parse', 'main']).trim()
  return { root, dir, g, featureSha, mainSha, remoteDir }
}

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const ops = await import('../server/ops.mjs')
  const git = await import('../server/git.mjs')
  return { tmp, store, ops, git }
}

function seedNodes(store) {
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  return { p, r, s }
}

// ---------- git 层：commitPushState 三态 ----------

test('commitPushState：已 push 的提交 → pushed，依据带远程 ref', async (t) => {
  const { git } = await setup()
  const { root, dir, mainSha } = makeRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const state = await git.commitPushState(dir, mainSha)
  assert.equal(state.status, 'pushed')
  assert.ok(state.refs.includes('origin/main'), `refs=${JSON.stringify(state.refs)}`)
  assert.equal(state.reason, null)
})

test('commitPushState：本地有、远程无的提交 → not_pushed（push 后翻成 pushed）', async (t) => {
  const { git } = await setup()
  const { root, dir, g, featureSha } = makeRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  let state = await git.commitPushState(dir, featureSha)
  assert.equal(state.status, 'not_pushed')
  assert.equal(state.reason, 'no-remote-ref-contains')
  assert.deepEqual(state.refs, [])

  g(['push', '-q', '-u', 'origin', 'feature'])
  state = await git.commitPushState(dir, featureSha)
  assert.equal(state.status, 'pushed')
  assert.ok(state.refs.includes('origin/feature'))
})

test('commitPushState：短 sha 也能判定（commit_add 允许 7–40 位）', async (t) => {
  const { git } = await setup()
  const { root, dir, g, featureSha } = makeRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const short = g(['rev-parse', '--short', featureSha]).trim()

  const state = await git.commitPushState(dir, short)
  assert.equal(state.status, 'not_pushed')
  assert.equal(state.reason, 'no-remote-ref-contains')
})

test('commitPushState：本地不存在的 sha → unknown / sha-not-found（不是 git-error）', async (t) => {
  const { git } = await setup()
  const { root, dir } = makeRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const state = await git.commitPushState(dir, 'deadbeefdeadbeef')
  assert.equal(state.status, 'unknown')
  // 关键回归：for-each-ref --contains=<坏 sha> 会 exit 129；必须先 rev-parse 兜住这个区分
  assert.equal(state.reason, 'sha-not-found')
})

test('commitPushState：没有配置远程 → unknown / no-remote（不是 not_pushed）', async (t) => {
  const { git } = await setup()
  const { root, dir, mainSha } = makeRepo({ withRemote: false })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const state = await git.commitPushState(dir, mainSha)
  assert.equal(state.status, 'unknown')
  assert.equal(state.reason, 'no-remote')
})

// ---------- 聚合层：getNodePushGate ----------

test('push gate：全部已推送 → ready=true，totals 分桶守恒', async (t) => {
  const { tmp, store, ops } = await setup()
  const { root, dir, mainSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { r } = seedNodes(store)
  store.addRepo({ name: 'repo', localPath: dir })
  store.addCommit(r.id, { repo: 'repo', sha: mainSha })

  const gate = await ops.getNodePushGate(store, r.id)
  assert.equal(gate.ready, true)
  assert.deepEqual(gate.totals, { commits: 1, pushed: 1, notPushed: 0, unknown: 0 })
  assert.deepEqual(gate.blockers, [])
  assert.equal(gate.items[0].status, 'pushed')
})

test('push gate：存在未推送提交 → ready=false，blocker 带原因', async (t) => {
  const { tmp, store, ops } = await setup()
  const { root, dir, featureSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { r } = seedNodes(store)
  store.addRepo({ name: 'repo', localPath: dir })
  store.addCommit(r.id, { repo: 'repo', sha: featureSha })

  const gate = await ops.getNodePushGate(store, r.id)
  assert.equal(gate.ready, false)
  assert.equal(gate.totals.notPushed, 1)
  assert.equal(gate.blockers.length, 1)
  assert.equal(gate.blockers[0].status, 'not_pushed')
  assert.equal(gate.blockers[0].reason, 'no-remote-ref-contains')
  // 说明要能指导修复
  assert.match(gate.blockers[0].detail, /push/)
})

test('push gate：未登记仓库 → unknown 且阻塞，reason=repo-not-registered（不冒充通过）', async (t) => {
  const { tmp, store, ops } = await setup()
  t.after(() => tmp.cleanup())
  const { r } = seedNodes(store)
  // 直接写一条标注了未登记仓库的提交（绕过 addCommit 的仓库校验，模拟历史脏数据）
  const p = store.resolveRef('P')
  store.addCommit(r.id, { sha: 'abcdef1' })
  store.db.prepare('UPDATE commits SET repo = ? WHERE node_id = ?').run('ghost', r.id)

  const gate = await ops.getNodePushGate(store, r.id)
  assert.equal(gate.ready, false)
  assert.equal(gate.totals.unknown, 1)
  assert.equal(gate.blockers[0].status, 'unknown')
  assert.equal(gate.blockers[0].reason, 'repo-not-registered')
  assert.ok(p)
})

test('D2 回归：仓库已登记但没填 localPath → reason=repo-path-unset，指出先补路径', async (t) => {
  const { tmp, store, ops } = await setup()
  t.after(() => tmp.cleanup())
  const { r } = seedNodes(store)
  // addRepo 不传 localPath：登记存在，但压根没有本地路径
  store.addRepo({ name: 'no-path' })
  store.addCommit(r.id, { repo: 'no-path', sha: 'abcdef1' })

  const gate = await ops.getNodePushGate(store, r.id)
  assert.equal(gate.ready, false)
  assert.equal(gate.blockers[0].status, 'unknown')
  // 旧实现会把这种情况也报成 repo-path-missing（「本地路径无效」），指向错误的修复动作
  assert.equal(gate.blockers[0].reason, 'repo-path-unset')
  assert.match(gate.blockers[0].detail, /local_path/)
})

test('D2 回归：已填 localPath 但路径无效 → reason=repo-path-missing，detail 用真实错误信息', async (t) => {
  const { tmp, store, ops } = await setup()
  t.after(() => tmp.cleanup())
  const { r } = seedNodes(store)
  const missingDir = path.join(os.tmpdir(), `taskboard-not-a-repo-${Date.now()}`)
  store.addRepo({ name: 'bad-path', localPath: missingDir })
  store.addCommit(r.id, { repo: 'bad-path', sha: 'abcdef1' })

  const gate = await ops.getNodePushGate(store, r.id)
  assert.equal(gate.blockers[0].reason, 'repo-path-missing')
  // detail 不再是一句笼统的固定文案，而是 resolveRepoDir 抛出的真实信息
  assert.match(gate.blockers[0].detail, /不是 git 仓库|不存在/)
  assert.match(gate.blockers[0].detail, new RegExp(missingDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('D1 回归：本机 git 不可用 → reason=git-unavailable（不再误报成路径问题）', async (t) => {
  const { tmp, store, ops } = await setup()
  const { root, dir, mainSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { r } = seedNodes(store)
  store.addRepo({ name: 'repo', localPath: dir })
  store.addCommit(r.id, { repo: 'repo', sha: mainSha })

  // 把 PATH 指到一个没有 git 的目录 → gitTry 抛 GIT_UNAVAILABLE
  const emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-nogit-'))
  const savedPath = process.env.PATH
  process.env.PATH = emptyPathDir
  let gate
  try {
    gate = await ops.getNodePushGate(store, r.id)
  } finally {
    process.env.PATH = savedPath
    fs.rmSync(emptyPathDir, { recursive: true, force: true })
  }

  assert.equal(gate.ready, false)
  assert.equal(gate.blockers[0].status, 'unknown')
  // 旧实现：e.code=GIT_UNAVAILABLE 落进 catch 的 else 分支 → 误报 repo-path-missing
  assert.equal(gate.blockers[0].reason, 'git-unavailable')
  assert.match(gate.blockers[0].detail, /git 不可用/)
})

test('reason 契约：四类可行动原因互不串味（unset / missing / unavailable / not-registered）', async (t) => {
  const { tmp, store, ops } = await setup()
  const { root, dir } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { r } = seedNodes(store)
  store.addRepo({ name: 'unset' })
  store.addRepo({ name: 'missing', localPath: path.join(os.tmpdir(), 'taskboard-nope-xyz') })
  store.addCommit(r.id, { repo: 'unset', sha: 'aaa1111' })
  store.addCommit(r.id, { repo: 'missing', sha: 'bbb2222' })
  store.addCommit(r.id, { sha: 'ccc3333' })
  store.db.prepare('UPDATE commits SET repo = ? WHERE sha = ?').run('ghostrepo', 'ccc3333')

  const gate = await ops.getNodePushGate(store, r.id)
  const reasons = gate.blockers.map((b) => b.reason).sort()
  assert.deepEqual(reasons, ['repo-not-registered', 'repo-path-missing', 'repo-path-unset'])
  // 每条 reason 都在标签表里有对应说明（契约完备：不会有 reason 无文案）
  for (const b of gate.blockers) assert.ok(b.detail && b.detail.length > 0, `${b.reason} 应有 detail`)
  assert.ok(dir)
})

test('push gate：没有已登记提交 → ready=null（不知道 ≠ 没通过）', async (t) => {
  const { tmp, store, ops } = await setup()
  t.after(() => tmp.cleanup())
  const { r } = seedNodes(store)

  const gate = await ops.getNodePushGate(store, r.id)
  assert.equal(gate.ready, null)
  assert.deepEqual(gate.totals, { commits: 0, pushed: 0, notPushed: 0, unknown: 0 })
  assert.deepEqual(gate.blockers, [])
})

test('push gate：scope=subtree 纳入子树提交，并按 (repo, sha) 去重回填来源节点', async (t) => {
  const { tmp, store, ops } = await setup()
  const { root, dir, mainSha, featureSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { p, r, s } = seedNodes(store)
  store.addRepo({ name: 'repo', localPath: dir })
  store.addCommit(r.id, { repo: 'repo', sha: mainSha })
  store.addCommit(s.id, { repo: 'repo', sha: featureSha })
  // 同一提交在子需求重复登记 → 去重成一条
  store.addCommit(s.id, { repo: 'repo', sha: mainSha })

  const self = await ops.getNodePushGate(store, r.id)
  assert.equal(self.totals.commits, 1)

  const subtree = await ops.getNodePushGate(store, r.id, { scope: 'subtree' })
  assert.equal(subtree.scope, 'subtree')
  assert.equal(subtree.totals.commits, 2)
  assert.equal(subtree.totals.pushed, 1)
  assert.equal(subtree.totals.notPushed, 1)
  assert.equal(subtree.ready, false)
  const pushedItem = subtree.items.find((i) => i.status === 'pushed')
  assert.equal(pushedItem.sourceNodes.length, 2)
  assert.deepEqual(
    pushedItem.sourceNodes.map((n) => n.path).sort(),
    ['P/R', 'P/R/S']
  )
})

test('push gate：纯读聚合不产生 revision（可高频轮询）', async (t) => {
  const { tmp, store, ops } = await setup()
  const { root, dir, mainSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { r } = seedNodes(store)
  store.addRepo({ name: 'repo', localPath: dir })
  store.addCommit(r.id, { repo: 'repo', sha: mainSha })
  const before = store.getRevision()

  await ops.getNodePushGate(store, r.id)
  await ops.getNodePushGate(store, r.id, { scope: 'subtree' })
  assert.equal(store.getRevision(), before)
})

test('push gate：非法 scope 拒绝（不静默降级成 self）', async (t) => {
  const { tmp, store, ops } = await setup()
  t.after(() => tmp.cleanup())
  const { r } = seedNodes(store)

  for (const bad of ['Subtree', 'sub', '', 'all']) {
    await assert.rejects(() => ops.getNodePushGate(store, r.id, { scope: bad }), /VALIDATION_FAILED/)
  }
})

// ---------- markdown 渲染 ----------

test('renderPushGateMd：输出结论与明细，并转义表格单元格', async (t) => {
  const { tmp, store, ops } = await setup()
  const { root, dir, featureSha } = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { p, r } = seedNodes(store)
  // 路径里带 `|`，验证渲染转义（否则会撑破表格）
  store.addRepo({ name: 'repo|odd', localPath: dir })
  store.addCommit(r.id, { repo: 'repo|odd', sha: featureSha })

  const gate = await ops.getNodePushGate(store, r.id)
  const md = ops.renderPushGateMd(gate)
  assert.match(md, /# 代码推送门禁：R/)
  assert.match(md, /存在未推送或无法判定的提交/)
  assert.match(md, /repo\\\|odd/)
  assert.ok(!/repo\|odd/.test(md), '未转义的竖线会撑破表格')
  assert.ok(p)
})

test('push gate：能力清单登记 commit_push_gate', async () => {
  const { TOOLS } = await import('../server/ops.mjs')
  assert.ok(TOOLS.includes('commit_push_gate'))
})

test('push gate：空态 markdown 明确「没有可判定的提交」', async (t) => {
  const { tmp, store, ops } = await setup()
  t.after(() => tmp.cleanup())
  const { r } = seedNodes(store)
  const md = ops.renderPushGateMd(await ops.getNodePushGate(store, r.id))
  assert.match(md, /没有可判定的提交/)
})
